import { getQueueToken } from '@nestjs/bullmq';
import { ForbiddenException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserStatus } from '@prisma/client';
import { EMAIL_NOT_VERIFIED_MESSAGE } from '../auth/email-confirmation.constants';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import type { SendEmailDto } from './dto/send-email.dto';
import {
  ACCOUNT_SUSPENDED_MESSAGE,
  DOMAIN_NOT_VERIFIED_MESSAGE,
  SEND_REFUSAL,
} from './emails.constants';
import { EmailsService, sendRefusalReason } from './emails.service';

/**
 * Envoi par l'API tel que le fait le contrôleur : la clé API qui porte l'envoi
 * est toujours transmise (B27, le point d'acceptation refuse un envoi sans elle).
 */
function sendAsKey(
  svc: EmailsService,
  userId: string,
  dto: SendEmailDto,
): ReturnType<EmailsService['send']> {
  return svc.send(userId, dto, 'key_1');
}

const USER_ID = 'user_1';

/**
 * Ligne `User` telle que la base la rend : `status` et `emailVerifiedAt` sont
 * des colonnes, toujours présentes dans un résultat qui les sélectionne.
 */
function userRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: UserStatus.ACTIVE,
    emailVerifiedAt: new Date('2026-02-01T10:00:00.000Z'),
    dailySendLimit: 200,
    email: 'aissatou@exemple.gn',
    ...overrides,
  };
}

function dtoWith(overrides: Partial<SendEmailDto> = {}): SendEmailDto {
  return {
    from: 'Awa Diallo <contact@boutique-awa.gn>',
    to: 'client@exemple.gn',
    subject: 'Votre commande est prête',
    html: '<p>Bonjour</p>',
    ...overrides,
  };
}

/** Renvoie l'erreur levée, ou échoue bruyamment si l'envoi a été accepté. */
async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Envoi accepté alors qu’un refus était attendu');
    },
    (error: unknown) => error,
  );
}

/**
 * État du compte au **point d'acceptation**, pas au garde HTTP.
 *
 * `ApiKeyAuthGuard` refuse déjà un compte suspendu et `EmailVerifiedGuard` un
 * compte non confirmé — mais ils ne protègent que `POST /v1/emails`. Ces tests
 * appellent `EmailsService.send()` **directement**, sans Express, sans garde,
 * exactement comme le fera le relais SMTP (B6) : ils prouvent que la règle vit
 * désormais dans le service et qu'elle ne dépend plus du point d'entrée.
 *
 * Le contrat HTTP, lui, est inchangé : mêmes classes d'exception, mêmes
 * statuts, mêmes messages. Le motif symbolique n'est qu'un supplément, lisible
 * par un appelant qui n'a pas de statut HTTP à renvoyer.
 */
describe('Point d’acceptation — état du compte (appel direct au service)', () => {
  let service: EmailsService;

  const domain = { findFirst: jest.fn() };
  const suppression = { findFirst: jest.fn() };
  const creditEntry = { aggregate: jest.fn(), create: jest.fn() };
  const email = { create: jest.fn(), count: jest.fn() };
  const user = { findUnique: jest.fn() };
  const queue = { add: jest.fn() };

  // Portée par domaine (B27) : ALL, ces scénarios n'éprouvent que l'état du compte.
  const apiKey = {
    findUnique: jest.fn(() =>
      Promise.resolve({ domainScope: 'ALL', domains: [] }),
    ),
  };

  const prisma = {
    domain,
    apiKey,
    suppression,
    creditEntry,
    email,
    user,
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Chemin nominal : tout est disponible, seul l'état du compte varie.
    domain.findFirst.mockResolvedValue({ id: 'dom_1' });
    suppression.findFirst.mockResolvedValue(null);
    creditEntry.aggregate.mockResolvedValue({ _sum: { delta: 10 } });
    creditEntry.create.mockResolvedValue({ id: 'credit_1' });
    email.count.mockResolvedValue(0);
    email.create.mockImplementation(
      ({ data }: { data: { publicId: string } }) =>
        Promise.resolve({ id: 'email_1', publicId: data.publicId }),
    );
    user.findUnique.mockResolvedValue(userRow());
    queue.add.mockResolvedValue({ id: 'job_1' });
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
        {
          provide: ConfigService,
          useValue: { get: () => undefined },
        },
      ],
    }).compile();

    service = module.get(EmailsService);
  });

  /**
   * Témoin : sans cette acceptation, les deux refus ci-dessous ne prouveraient
   * rien — ils pourraient venir de n'importe quelle autre règle du pipeline.
   */
  it('accepte l’envoi quand le compte est actif et son adresse confirmée', async () => {
    await expect(sendAsKey(service, USER_ID, dtoWith())).resolves.toMatchObject(
      {
        status: 'queued',
      },
    );
  });

  it('refuse un compte SUSPENDED, alors qu’aucun garde HTTP n’est traversé', async () => {
    user.findUnique.mockResolvedValue(
      userRow({ status: UserStatus.SUSPENDED }),
    );

    const error = await refusalOf(sendAsKey(service, USER_ID, dtoWith()));

    // Contrat HTTP intact : c'est le 403 de `ApiKeyAuthGuard`, au mot près.
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      ACCOUNT_SUSPENDED_MESSAGE,
    );
    expect((error as ForbiddenException).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
    // Et le motif, lui, est exploitable sans HTTP (→ `550 5.7.1` en SMTP).
    expect(sendRefusalReason(error)).toBe(SEND_REFUSAL.ACCOUNT_SUSPENDED);

    // Aucun effet de bord : c'est ce que T12 existe pour empêcher.
    expect(email.create).not.toHaveBeenCalled();
    expect(creditEntry.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuse un compte dont emailVerifiedAt est null, alors qu’aucun garde HTTP n’est traversé', async () => {
    user.findUnique.mockResolvedValue(userRow({ emailVerifiedAt: null }));

    const error = await refusalOf(sendAsKey(service, USER_ID, dtoWith()));

    // Contrat HTTP intact : c'est le 403 de `EmailVerifiedGuard`, au mot près.
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      EMAIL_NOT_VERIFIED_MESSAGE,
    );
    expect((error as ForbiddenException).getStatus()).toBe(
      HttpStatus.FORBIDDEN,
    );
    expect(sendRefusalReason(error)).toBe(SEND_REFUSAL.EMAIL_NOT_VERIFIED);

    expect(email.create).not.toHaveBeenCalled();
    expect(creditEntry.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  /**
   * L'état du compte est le tout premier contrôle : un compte suspendu ne doit
   * pas apprendre, au passage, si tel domaine est vérifié chez lui — et ne doit
   * surtout pas voir son solde ou son quota consultés.
   */
  it.each([
    ['SUSPENDED', userRow({ status: UserStatus.SUSPENDED })],
    ['non confirmé', userRow({ emailVerifiedAt: null })],
  ])('refuse un compte %s avant toute autre règle', async (_label, row) => {
    user.findUnique.mockResolvedValue(row);

    await refusalOf(sendAsKey(service, USER_ID, dtoWith()));

    expect(domain.findFirst).not.toHaveBeenCalled();
    expect(suppression.findFirst).not.toHaveBeenCalled();
    expect(creditEntry.aggregate).not.toHaveBeenCalled();
    expect(email.count).not.toHaveBeenCalled();
  });

  /**
   * Le motif n'est pas réservé aux deux règles rapatriées : c'est le
   * discriminant de tous les refus du point d'acceptation. Sans lui, un
   * appelant non-HTTP devrait deviner à partir d'un 403 partagé par quatre
   * motifs distincts.
   */
  it('porte aussi le motif sur un refus préexistant, sans en changer le 403', async () => {
    domain.findFirst.mockResolvedValue(null);

    const error = await refusalOf(sendAsKey(service, USER_ID, dtoWith()));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      DOMAIN_NOT_VERIFIED_MESSAGE,
    );
    expect(sendRefusalReason(error)).toBe(SEND_REFUSAL.DOMAIN_NOT_VERIFIED);
  });

  it('ne prête aucun motif à une erreur qui ne vient pas du point d’acceptation', () => {
    expect(sendRefusalReason(new Error('Redis indisponible'))).toBeNull();
    expect(sendRefusalReason(undefined)).toBeNull();
    expect(sendRefusalReason(null)).toBeNull();
  });
});
