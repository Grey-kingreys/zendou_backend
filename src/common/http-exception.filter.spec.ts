import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ArgumentsHost,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ApiKeyAuthGuard } from '../api-keys';
import { hashApiKey } from '../api-keys/api-key.utils';
import { INVALID_API_KEY_MESSAGE } from '../api-keys/api-keys.constants';
import { EmailVerifiedGuard } from '../auth';
import { HealthController } from '../health/health.controller';
import { HealthService } from '../health/health.service';
import { EmailsController } from '../emails/emails.controller';
import { EmailsService, sendRefusalReason } from '../emails/emails.service';
import {
  INVALID_FROM_MESSAGE,
  INVALID_TO_MESSAGE,
  SEND_REFUSAL,
  SUBJECT_LENGTH_MESSAGE,
} from '../emails/emails.constants';
import type { SendEmailDto } from '../emails/dto/send-email.dto';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import {
  SMTP_REPLY_RCPT_TO_UNREADABLE,
  smtpReplyForError,
} from '../smtp/smtp-reply';
import { SnsSignatureValidator } from '../sns-webhook/sns-signature.validator';
import { SnsWebhookModule } from '../sns-webhook/sns-webhook.module';
import { SnsWebhookService } from '../sns-webhook/sns-webhook.service';
import { deliveryFixture } from '../sns-webhook/fixtures';
import { AllExceptionsFilter } from './http-exception.filter';

const USER_ID = 'user_1';
const API_KEY = 'zd_live_cle_de_test_0123456789abcdef';

/**
 * Détail interne volontairement « juteux » : identifiants et adresse d'hôte.
 * Aucun de ces caractères ne doit apparaître dans un corps HTTP.
 */
const SECRET_INTERNAL_DETAIL =
  'ECONNREFUSED 10.0.0.7:5432 — mot de passe base « s3cr3t-postgres »';

/** Compte autorisé à envoyer : actif, adresse confirmée. */
const ACCOUNT = {
  id: USER_ID,
  email: 'awa@boutique-awa.gn',
  name: 'Awa Diallo',
  company: null,
  declaredUsage: null,
  role: 'CUSTOMER',
  status: 'ACTIVE',
  emailVerifiedAt: new Date('2026-08-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Requête valide, dont chaque test ne dérange qu'un champ à la fois. */
const VALID_BODY: SendEmailDto = {
  from: 'contact@boutique-awa.gn',
  to: 'client@exemple.gn',
  subject: 'Votre commande est prête',
  html: '<p>Bonjour</p>',
};

/**
 * Les deux requêtes du rapport d'intégration : **même code 400, même phrase
 * métier, deux chemins d'échec**. `to` en tableau échoue chez class-validator
 * (`@IsString`), `to` avec nom d'affichage échoue dans `EmailsService.accept`
 * (`normalizeEmailAddress` refuse la partie locale « Nom <client »), qui lève
 * un `BadRequestException` à la main. Les deux messages sont la même constante
 * `INVALID_TO_MESSAGE`, partagée exprès entre le DTO et le service.
 */
const PORTEUR_TABLEAU = { ...VALID_BODY, to: ['client@exemple.gn'] };
const PORTEUR_CHAINE = { ...VALID_BODY, to: 'Nom <client@exemple.gn>' };

// ---------------------------------------------------------------------------
// Cobayes : les deux chemins qu'aucune route réelle ne permet d'atteindre à la
// demande — une exception qui n'est pas une `HttpException`, et une réponse
// 2xx sans corps.
// ---------------------------------------------------------------------------

@Controller('cobayes')
class CobayeController {
  @Get('boum')
  boum(): never {
    throw new Error(SECRET_INTERNAL_DETAIL);
  }

  @Get('refus-manuel')
  refusManuel(): never {
    throw new BadRequestException(INVALID_FROM_MESSAGE);
  }

  @Delete('sans-corps')
  @HttpCode(HttpStatus.NO_CONTENT)
  sansCorps(): void {}

  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }
}

interface ErrorBody {
  statusCode?: unknown;
  error?: unknown;
  message?: unknown;
  errors?: unknown;
}

function bodyOf(response: { body: unknown }): ErrorBody {
  return response.body as ErrorBody;
}

/**
 * Vérifie le contrat, et rend les deux champs typés pour la suite du test.
 *
 * C'est le cœur de ce fichier : `message` **toujours** une chaîne, `errors`
 * **toujours** un tableau de chaînes non vide, et l'invariant qui les relie.
 */
function expectContract(
  response: { body: unknown; status: number },
  status: number,
): { message: string; errors: string[] } {
  const body = bodyOf(response);

  expect(response.status).toBe(status);
  expect(body.statusCode).toBe(status);

  expect(typeof body.message).toBe('string');
  expect(Array.isArray(body.errors)).toBe(true);

  const errors = body.errors as string[];
  expect(errors.length).toBeGreaterThan(0);
  errors.forEach((entry) => expect(typeof entry).toBe('string'));

  expect(body.message).toBe(errors.join(' '));

  return { message: body.message as string, errors };
}

describe("Filtre d'erreur global — forme du corps, bout en bout", () => {
  let app: INestApplication<App>;
  let emailsService: EmailsService;

  const prisma = {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };

  const queue = { add: jest.fn() };
  const configService = { get: jest.fn(() => undefined) };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      // Le vrai contrôleur, le vrai DTO, le vrai service, les vrais gardes :
      // seuls la base, la file et la configuration sont doublés. Les deux
      // chemins d'échec du rapport passent donc par le code de production.
      controllers: [EmailsController, CobayeController],
      providers: [
        EmailsService,
        ApiKeyAuthGuard,
        EmailVerifiedGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();

    // Exactement le montage de `main.ts` — même pipe, même filtre.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    emailsService = moduleRef.get(EmailsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    prisma.apiKey.findUnique.mockImplementation(
      ({ where }: { where: { keyHash: string } }) =>
        Promise.resolve(
          where.keyHash === hashApiKey(API_KEY)
            ? { id: 'ak_1', revokedAt: null, user: ACCOUNT }
            : null,
        ),
    );
    prisma.apiKey.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({
      status: ACCOUNT.status,
      emailVerifiedAt: ACCOUNT.emailVerifiedAt,
    });
  });

  const postEmail = (body: unknown) =>
    request(app.getHttpServer())
      .post('/emails')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send(body as object);

  // -------------------------------------------------------------------------
  // 1. class-validator, plusieurs champs
  // -------------------------------------------------------------------------

  it('rend une chaîne et un détail par champ quand plusieurs champs sont invalides', async () => {
    const response = await postEmail({
      from: 42,
      to: ['client@exemple.gn'],
      subject: '',
      html: '<p>Bonjour</p>',
    });

    const { message, errors } = expectContract(response, 400);

    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual(
      expect.arrayContaining([
        INVALID_FROM_MESSAGE,
        INVALID_TO_MESSAGE,
        SUBJECT_LENGTH_MESSAGE,
      ]),
    );

    // La phrase affichable contient bien les trois griefs, pas seulement le
    // premier : c'est ce que `errors.join(' ')` doit produire.
    expect(message).toContain(INVALID_FROM_MESSAGE);
    expect(message).toContain(INVALID_TO_MESSAGE);
    expect(message).toContain(SUBJECT_LENGTH_MESSAGE);

    // `error` et `statusCode` inchangés : le contrat n'ajoute que `errors`.
    expect(bodyOf(response).error).toBe('Bad Request');
  });

  // -------------------------------------------------------------------------
  // 2. class-validator, un seul champ
  // -------------------------------------------------------------------------

  it('rend un `errors` de longueur 1 quand un seul champ est invalide', async () => {
    const response = await postEmail(PORTEUR_TABLEAU);

    const { message, errors } = expectContract(response, 400);

    expect(errors).toEqual([INVALID_TO_MESSAGE]);
    expect(message).toBe(INVALID_TO_MESSAGE);
  });

  // -------------------------------------------------------------------------
  // 3. `throw new BadRequestException("…")` manuel
  // -------------------------------------------------------------------------

  it('donne la même forme à un `BadRequestException` levé à la main', async () => {
    const response = await request(app.getHttpServer()).get(
      '/cobayes/refus-manuel',
    );

    const { message, errors } = expectContract(response, 400);

    expect(errors).toEqual([INVALID_FROM_MESSAGE]);
    expect(message).toBe(INVALID_FROM_MESSAGE);
    expect(bodyOf(response).error).toBe('Bad Request');
  });

  // -------------------------------------------------------------------------
  // 4. 401 de garde
  // -------------------------------------------------------------------------

  it('donne la même forme au 401 du garde quand la clé API est absente', async () => {
    const response = await request(app.getHttpServer())
      .post('/emails')
      .send(VALID_BODY);

    const { message, errors } = expectContract(response, 401);

    expect(errors).toEqual([INVALID_API_KEY_MESSAGE]);
    expect(message).toBe(INVALID_API_KEY_MESSAGE);
    expect(bodyOf(response).error).toBe('Unauthorized');
  });

  it('donne la même forme au 401 du garde quand la clé API est inconnue', async () => {
    const response = await request(app.getHttpServer())
      .post('/emails')
      .set('Authorization', 'Bearer zd_live_cle_qui_nexiste_pas')
      .send(VALID_BODY);

    const { message, errors } = expectContract(response, 401);

    expect(errors).toEqual([INVALID_API_KEY_MESSAGE]);
    expect(message).toBe(INVALID_API_KEY_MESSAGE);
  });

  // -------------------------------------------------------------------------
  // 5. Exception inattendue → 500 générique
  // -------------------------------------------------------------------------

  it('rend un 500 générique et journalise une exception qui n’est pas une HttpException', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    try {
      const response = await request(app.getHttpServer()).get('/cobayes/boum');

      const { message, errors } = expectContract(response, 500);

      expect(errors).toHaveLength(1);
      expect(message).toBe(errors[0]);

      // Rien de l'interne ne sort : ni le message de l'erreur, ni la pile.
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(SECRET_INTERNAL_DETAIL);
      expect(raw).not.toContain('s3cr3t-postgres');
      expect(raw).not.toContain('10.0.0.7');
      expect(raw).not.toContain('http-exception.filter');
      expect(raw).not.toContain('at ');
      expect(response.text).not.toContain(SECRET_INTERNAL_DETAIL);

      // …mais tout arrive au journal, pile comprise.
      expect(logged).toHaveBeenCalledTimes(1);
      const [loggedMessage, loggedStack] = logged.mock.calls[0] as [
        string,
        string | undefined,
      ];
      expect(loggedMessage).toBe(SECRET_INTERNAL_DETAIL);
      expect(loggedStack).toContain(SECRET_INTERNAL_DETAIL);
      expect(loggedStack).toContain('at ');
    } finally {
      logged.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Le cas exact du rapport d'intégration
  // -------------------------------------------------------------------------

  it('rend une forme identique aux deux requêtes du rapport (tableau vs chaîne)', async () => {
    const [parPipe, parThrow] = await Promise.all([
      postEmail(PORTEUR_TABLEAU),
      postEmail(PORTEUR_CHAINE),
    ]);

    const viaPipe = expectContract(parPipe, 400);
    const viaThrow = expectContract(parThrow, 400);

    // Le symptôme d'origine : `message` était un tableau d'un côté, une
    // chaîne de l'autre. Il ne peut plus l'être.
    expect(Array.isArray(bodyOf(parPipe).message)).toBe(false);
    expect(Array.isArray(bodyOf(parThrow).message)).toBe(false);
    expect(typeof bodyOf(parPipe).message).toBe(
      typeof bodyOf(parThrow).message,
    );
    expect(Array.isArray(bodyOf(parPipe).errors)).toBe(
      Array.isArray(bodyOf(parThrow).errors),
    );

    // Même phrase métier, donc même corps — champ pour champ.
    expect(viaPipe.message).toBe(INVALID_TO_MESSAGE);
    expect(viaThrow.message).toBe(INVALID_TO_MESSAGE);
    expect(viaPipe.errors).toEqual(viaThrow.errors);
    expect(bodyOf(parPipe)).toEqual(bodyOf(parThrow));

    // La panne silencieuse elle-même : le client qui lisait `message[0]`
    // récupérait la phrase entière d'un côté, la lettre « L » de l'autre.
    // Les deux lectures coïncident désormais, et le détail granulaire se lit
    // dans `errors[0]`.
    expect(viaPipe.message[0]).toBe(viaThrow.message[0]);
    expect(viaPipe.errors[0]).toBe(viaThrow.errors[0]);
    expect(viaPipe.errors[0]).toBe(INVALID_TO_MESSAGE);
  });

  // -------------------------------------------------------------------------
  // Piège 1 — les réponses 2xx ne passent pas par le filtre
  // -------------------------------------------------------------------------

  it('laisse un 204 sans corps totalement intact', async () => {
    const response = await request(app.getHttpServer()).delete(
      '/cobayes/sans-corps',
    );

    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(response.text).toBe('');
    expect(response.body).toEqual({});
  });

  it("n'ajoute ni `message` ni `errors` à une réponse 2xx qui réussit", async () => {
    const response = await request(app.getHttpServer()).get('/cobayes/ok');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('laisse passer un envoi valide en 202, sans corps d’erreur', async () => {
    jest
      .spyOn(emailsService, 'send')
      .mockResolvedValue({ id: 'e_0123456789ab', status: 'queued' });

    const response = await postEmail(VALID_BODY);

    expect(response.status).toBe(HttpStatus.ACCEPTED);
    expect(response.body).toEqual({ id: 'e_0123456789ab', status: 'queued' });
    expect(bodyOf(response).errors).toBeUndefined();

    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Piège 4 — le relais SMTP lit l'exception, pas le corps HTTP
  // -------------------------------------------------------------------------

  it("ne mute ni l'exception ni son corps : `smtpReplyForError` lit la même chose après le filtre", async () => {
    // Vraie exception de refus, produite par le vrai point d'acceptation —
    // c'est elle que le relais SMTP inspecte, avec son motif `SEND_REFUSAL`
    // posé en propriété non énumérable.
    let captured: unknown;

    try {
      await emailsService.send(USER_ID, PORTEUR_CHAINE);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(BadRequestException);
    const exception = captured as BadRequestException;

    const reasonBefore = sendRefusalReason(exception);
    const replyBefore = smtpReplyForError(exception);
    const responseBefore = JSON.stringify(exception.getResponse());

    expect(reasonBefore).toBe(SEND_REFUSAL.INVALID_TO);
    expect(replyBefore).toBe(SMTP_REPLY_RCPT_TO_UNREADABLE);

    // On fait passer cette exception précise par le filtre.
    const json = jest.fn<void, [unknown]>();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter().catch(exception, host);

    // Le corps HTTP est bien normalisé…
    expect(status).toHaveBeenCalledWith(400);
    const emitted = json.mock.calls[0][0] as ErrorBody;
    expect(emitted.message).toBe(INVALID_TO_MESSAGE);
    expect(emitted.errors).toEqual([INVALID_TO_MESSAGE]);

    // …et l'exception, elle, n'a pas bougé d'un cheveu : même motif, même
    // réponse SMTP, même corps interne.
    expect(sendRefusalReason(exception)).toBe(reasonBefore);
    expect(smtpReplyForError(exception)).toBe(replyBefore);
    expect(JSON.stringify(exception.getResponse())).toBe(responseBefore);
  });
});

// ---------------------------------------------------------------------------
// Piège 2 — le webhook SNS et sa grille de codes très particulière
// ---------------------------------------------------------------------------

describe('Filtre d’erreur global — webhook SNS, codes inchangés', () => {
  let app: INestApplication<App>;

  const snsWebhookService = { handle: jest.fn() };
  const signatureValidator = { isValid: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    snsWebhookService.handle.mockResolvedValue(undefined);
    signatureValidator.isValid.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [SnsWebhookModule],
    })
      .overrideProvider(SnsWebhookService)
      .useValue(snsWebhookService)
      .overrideProvider(SnsSignatureValidator)
      .useValue(signatureValidator)
      .compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: string) =>
    request(app.getHttpServer())
      .post('/webhooks/sns')
      .set('Content-Type', 'text/plain; charset=UTF-8')
      .send(body);

  it('acquitte toujours en 200 avec le corps exact attendu par SNS', async () => {
    const response = await post(JSON.stringify(deliveryFixture()));

    expect(response.status).toBe(200);
    // Le filtre n'a rien ajouté : SNS reçoit toujours `{ received: true }`.
    expect(response.body).toEqual({ received: true });
  });

  it('acquitte encore en 200 quand le traitement métier échoue', async () => {
    snsWebhookService.handle.mockRejectedValue(new Error('base indisponible'));

    const response = await post(JSON.stringify(deliveryFixture()));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it('garde le 403 sur signature invalide, au format normalisé', async () => {
    signatureValidator.isValid.mockResolvedValue(false);

    const response = await post(JSON.stringify(deliveryFixture()));

    const { message, errors } = expectContract(response, 403);

    expect(message).toBe('Signature SNS invalide');
    expect(errors).toEqual(['Signature SNS invalide']);
    expect(bodyOf(response).error).toBe('Forbidden');
  });

  it('garde le 400 sur corps illisible, au format normalisé', async () => {
    const response = await post('ceci n’est pas du JSON');

    const { message, errors } = expectContract(response, 400);

    expect(message).toBe('Message SNS invalide');
    expect(errors).toEqual(['Message SNS invalide']);
    expect(bodyOf(response).error).toBe('Bad Request');
  });
});

// ---------------------------------------------------------------------------
// Une `HttpException` dont le corps est un diagnostic, sans champ `message` :
// le 503 de `/health`, relais SMTP activé mais à l'arrêt (A16). Le corps dit
// déjà quel maillon est tombé — le repli ne doit pas écrire par-dessus une
// panne serveur imaginaire.
// ---------------------------------------------------------------------------

describe('Filtre d’erreur global — 503 de /health, diagnostic préservé', () => {
  let app: INestApplication<App>;
  const healthService = { check: jest.fn() };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('garde intacts les champs du diagnostic et ne parle pas d’erreur interne', async () => {
    const diagnostic = {
      status: 'error',
      db: 'ok',
      redis: 'ok',
      smtp: 'down',
    };
    healthService.check.mockResolvedValue(diagnostic);

    const response = await request(app.getHttpServer()).get('/health');

    const { message, errors } = expectContract(response, 503);

    // Le diagnostic survit champ pour champ : c'est lui l'information utile.
    expect(bodyOf(response)).toMatchObject(diagnostic);

    // Et le repli ne raconte pas une panne serveur là où le relais est
    // simplement arrêté : ce message-là enverrait l'ops sur une fausse piste.
    expect(message).not.toBe('Internal server error');
    expect(message).toBe('Service Unavailable');
    expect(errors).toEqual(['Service Unavailable']);
  });

  it('laisse le 200 de /health totalement intact', async () => {
    const diagnostic = { status: 'ok', db: 'ok', redis: 'ok', smtp: 'ok' };
    healthService.check.mockResolvedValue(diagnostic);

    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    // Aucun `message`, aucun `errors` : une réponse qui réussit ne passe pas
    // par le filtre.
    expect(response.body).toEqual(diagnostic);
  });
});

// ---------------------------------------------------------------------------
// Le filtre ne sert à rien s'il n'est pas branché : ce contrôle est là pour
// que le montage de `main.ts` ne parte pas silencieusement à la dérive — même
// esprit que `config/env-example.consistency.spec.ts`.
// ---------------------------------------------------------------------------

describe('main.ts — enregistrement du filtre', () => {
  it('monte `AllExceptionsFilter` en filtre global', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

    expect(main).toContain('AllExceptionsFilter');
    expect(main).toContain('useGlobalFilters(new AllExceptionsFilter())');
  });
});
