import { Socket } from 'net';
import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  DomainStatus,
  EmailChannel,
  EmailStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { createTransport } from 'nodemailer';
import {
  EMAIL_SEND_JOB,
  FAILED_EMAIL_JOB_RETENTION_SECONDS,
} from '../emails/emails.constants';
import { EmailsService } from '../emails/emails.service';
import type { EmailSendJobData } from '../emails/emails.types';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_SEND_QUEUE } from '../queues/queues';
import { generateSmtpCredentialSecret } from '../smtp-credentials';
import { FakeThrottleRedis } from './fixtures/fake-throttle-redis';
import { SmtpAuthService } from './smtp-auth.service';
import {
  SMTP_REPLY_RAW_NOT_UTF8,
  SUBJECT_ABSENT_LABEL,
} from './smtp-pipeline.constants';
import { SmtpPipelineService } from './smtp-pipeline.service';
import {
  SMTP_REPLY_DOMAIN_NOT_VERIFIED,
  SMTP_REPLY_INSUFFICIENT_CREDITS,
  SMTP_REPLY_MIME_INVALID,
  SMTP_REPLY_REPLY_TO_NOT_VERIFIED,
  SMTP_REPLY_REPLY_TO_UNREADABLE,
  SMTP_REPLY_SIZE_EXCEEDED,
  SMTP_REPLY_TOO_MANY_RECIPIENTS,
  SMTP_REPLY_ACCOUNT_SUSPENDED,
  SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED,
} from './smtp-reply';
import { SmtpServerService } from './smtp-server.service';
import { SMTP_THROTTLE_REDIS } from './smtp-throttle.constants';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * **Pipeline SMTP de bout en bout, dans le processus de test** (B6/S7 — §7 du
 * plan) : un vrai client `nodemailer` parle à un vrai serveur `smtp-server` sur
 * un port éphémère, et la conversation aboutit au **vrai** point d'acceptation
 * partagé (`EmailsService`), avec ses vraies règles.
 *
 * Ce qui est doublé, et rien d'autre : Prisma (magasin en mémoire à sémantique
 * de requête réelle — il compte et filtre pour de bon), la file BullMQ, et le
 * Redis de l'anti-abus. `EmailsService`, `SmtpPipelineService`,
 * `SmtpServerService`, `SmtpAuthService`, `SmtpThrottleService`, l'analyse
 * MIME et la table des codes de réponse sont le code de production.
 *
 * C'est ce montage qui rend les preuves de ce fichier réelles : quand un test
 * affirme « exactement un crédit débité », c'est le débit qu'`accept()` a
 * réellement écrit, pas une valeur soufflée à un mock.
 */

jest.setTimeout(30_000);

const HOST = '127.0.0.1';

const USER_ID = 'user_actif';
const USER_EMAIL = 'aissatou@example.com';
const CREDENTIAL_ID = 'smtpcred_valide';
const USERNAME = 'zdu_valide';
const CLIENT_DOMAIN = 'boutique-awa.gn';
const CLIENT_FROM = `contact@${CLIENT_DOMAIN}`;
const ZENDOU_DOMAIN = 'mail.kingreys.fr';
const TEST_FROM = `onboarding@${ZENDOU_DOMAIN}`;

const secret = generateSmtpCredentialSecret();

/** Erreur telle que `nodemailer` la remonte quand le serveur refuse. */
interface SmtpClientError extends Error {
  responseCode?: number;
  response?: string;
}

interface EmailRow {
  id: string;
  publicId: string;
  userId: string;
  domainId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  channel: EmailChannel;
  smtpCredentialId: string | null;
  system: boolean;
  queuedAt: Date;
}

interface CreditRow {
  userId: string;
  delta: number;
  reason: string;
  reference: string | null;
}

/**
 * Magasin Prisma en mémoire : il applique réellement les filtres dont le
 * pipeline dépend (propriété et statut d'un domaine, portée d'une suppression,
 * quota du jour), au lieu de rendre des réponses pré-programmées. Un test qui
 * passe ici passe donc pour la bonne raison.
 */
class FakeStore {
  readonly emails: EmailRow[] = [];
  readonly credits: CreditRow[] = [];
  readonly suppressions: { address: string; userId: string | null }[] = [];

  readonly domains = [
    { id: 'dom_client', name: CLIENT_DOMAIN, userId: USER_ID, verified: true },
    // Domaine de Zendou : celui de `TEST_EMAIL_FROM`, vérifié mais possédé par
    // personne d'autre que nous.
    {
      id: 'dom_zendou',
      name: ZENDOU_DOMAIN,
      userId: 'user_zendou',
      verified: true,
    },
  ];

  userRow = {
    id: USER_ID,
    email: USER_EMAIL,
    name: 'Aïssatou Diallo',
    company: null,
    declaredUsage: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE as UserStatus,
    dailySendLimit: 200,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z') as Date | null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  private nextId = 1;

  readonly smtpCredential = {
    findUnique: jest.fn(({ where }: { where: { username: string } }) =>
      Promise.resolve(
        where.username === USERNAME
          ? {
              id: CREDENTIAL_ID,
              username: USERNAME,
              secretHash: secret.passwordHash,
              revokedAt: null,
              user: this.userRow,
            }
          : null,
      ),
    ),
    update: jest.fn(() => Promise.resolve({ id: CREDENTIAL_ID })),
  };

  readonly domain = {
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { name: string; userId?: string; status: DomainStatus };
      }) => {
        const hit = this.domains.find(
          (row) =>
            row.name === where.name &&
            row.verified === (where.status === DomainStatus.VERIFIED) &&
            (where.userId === undefined || row.userId === where.userId),
        );

        return Promise.resolve(hit ? { id: hit.id } : null);
      },
    ),
  };

  readonly suppression = {
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { address: string; OR: { userId: string | null }[] };
      }) => {
        const scopes = where.OR.map((clause) => clause.userId);
        const hit = this.suppressions.find(
          (row) => row.address === where.address && scopes.includes(row.userId),
        );

        return Promise.resolve(hit ? { id: 'sup_1' } : null);
      },
    ),
  };

  readonly email = {
    create: jest.fn(({ data }: { data: Partial<EmailRow> }) => {
      const row: EmailRow = {
        id: `email_${this.nextId++}`,
        publicId: data.publicId as string,
        userId: data.userId as string,
        domainId: data.domainId ?? null,
        fromAddress: data.fromAddress as string,
        toAddress: data.toAddress as string,
        subject: data.subject as string,
        status: data.status ?? EmailStatus.QUEUED,
        channel: data.channel ?? EmailChannel.API,
        smtpCredentialId: data.smtpCredentialId ?? null,
        system: data.system ?? false,
        queuedAt: new Date(),
      };
      this.emails.push(row);

      return Promise.resolve({ id: row.id, publicId: row.publicId });
    }),

    count: jest.fn(
      ({
        where,
      }: {
        where: { userId: string; system: boolean; queuedAt: { gte: Date } };
      }) =>
        Promise.resolve(
          this.emails.filter(
            (row) =>
              row.userId === where.userId &&
              row.system === where.system &&
              row.queuedAt >= where.queuedAt.gte,
          ).length,
        ),
    ),
  };

  readonly creditEntry = {
    create: jest.fn(({ data }: { data: CreditRow }) => {
      this.credits.push(data);

      return Promise.resolve(data);
    }),
    aggregate: jest.fn(() =>
      Promise.resolve({
        _sum: {
          delta: this.credits.reduce((total, row) => total + row.delta, 0),
        },
      }),
    ),
  };

  readonly user = {
    findUnique: jest.fn(() => Promise.resolve(this.userRow)),
  };

  readonly $transaction = jest.fn(
    (run: (tx: FakeStore) => Promise<unknown>): Promise<unknown> => run(this),
  );

  /** Débits d'envoi seuls (le crédit de départ n'en est pas un). */
  get sendDebits(): CreditRow[] {
    return this.credits.filter((row) => row.reason === 'SEND');
  }
}

/**
 * Mock de `Queue.add` **typé sur sa vraie signature** : sans cela, chaque
 * lecture de `mock.calls` retomberait en `any` et les assertions sur la charge
 * utile du job — le point le plus important de ce fichier après les crédits —
 * ne vérifieraient plus rien à la compilation.
 */
type QueueAddMock = jest.Mock<
  Promise<{ id: string }>,
  [string, EmailSendJobData, { jobId: string }]
>;

interface Relay {
  moduleRef: TestingModule;
  server: SmtpServerService;
  emails: EmailsService;
  throttle: SmtpThrottleService;
  store: FakeStore;
  queue: { add: QueueAddMock };
  config: Record<string, unknown>;
  port: number;
}

async function startRelay(
  overrides: Record<string, unknown> = {},
): Promise<Relay> {
  const store = new FakeStore();
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job_1' }) as QueueAddMock,
  };
  const config: Record<string, unknown> = {
    NODE_ENV: 'test',
    SMTP_RELAY_ENABLED: true,
    SMTP_PORTS_STARTTLS: [0],
    SMTP_PORTS_TLS: [],
    SMTP_BIND_ADDRESS: HOST,
    SMTP_MAX_CLIENTS: 20,
    SMTP_SOCKET_TIMEOUT_MS: 10_000,
    SMTP_CLOSE_TIMEOUT_MS: 1_000,
    TEST_EMAIL_FROM: `Zendou <${TEST_FROM}>`,
    ...overrides,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SmtpServerService,
      SmtpAuthService,
      SmtpPipelineService,
      SmtpThrottleService,
      EmailsService,
      {
        provide: SMTP_THROTTLE_REDIS,
        useValue: new FakeThrottleRedis().asRedis(),
      },
      { provide: PrismaService, useValue: store },
      { provide: getQueueToken(EMAIL_SEND_QUEUE), useValue: queue },
      {
        provide: ConfigService,
        useValue: { get: (key: string) => config[key] },
      },
    ],
  }).compile();

  const server = moduleRef.get(SmtpServerService);
  await server.onModuleInit();

  // Crédits de départ : de quoi couvrir tous les scénarios sauf ceux qui
  // éprouvent précisément l'épuisement du solde.
  store.credits.push({
    userId: USER_ID,
    delta: 100,
    reason: 'TOPUP',
    reference: null,
  });

  return {
    moduleRef,
    server,
    emails: moduleRef.get(EmailsService),
    throttle: moduleRef.get(SmtpThrottleService),
    store,
    queue,
    config,
    port: server.listeningPorts[0],
  };
}

async function stopRelay(relay: Relay): Promise<void> {
  await relay.server.onModuleDestroy();
  await relay.moduleRef.close();
}

/** Message MIME complet, terminaisons de ligne canoniques comprises. */
function mime(headers: string[], body: string): string {
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

interface SendOptions {
  envelopeFrom?: string;
  to: string | string[];
  raw: string | Buffer;
}

/**
 * Ce que `nodemailer` rend d'un envoi. `SentMessageInfo` est typé `any` par
 * `@types/nodemailer` (le transport en décide la forme) : on le nomme ici plutôt
 * que de laisser un `any` se propager dans les assertions.
 */
interface SentMessageInfo {
  response: string;
  rejected: string[];
  rejectedErrors?: SmtpClientError[];
}

/** Résultat d'un envoi : la réponse du serveur, ou son refus. */
interface SendResult {
  response?: string;
  rejectedErrors?: SmtpClientError[];
  error?: SmtpClientError;
}

async function send(port: number, options: SendOptions): Promise<SendResult> {
  const transport = createTransport({
    host: HOST,
    port,
    secure: false,
    // Canal en clair réservé aux tests, celui qu'`allowInsecureAuth` autorise.
    ignoreTLS: true,
    auth: { user: USERNAME, pass: secret.password },
  });

  try {
    // Enveloppe explicite : c'est elle qui porte le `MAIL FROM` et les
    // `RCPT TO`, indépendamment des en-têtes du message — exactement ce que le
    // §4.3 sépare, et ce que les scénarios de ce fichier éprouvent.
    const info = (await transport.sendMail({
      envelope: {
        from: options.envelopeFrom ?? CLIENT_FROM,
        to: Array.isArray(options.to) ? options.to : [options.to],
      },
      raw: options.raw,
    })) as SentMessageInfo;

    return { response: info.response, rejectedErrors: info.rejectedErrors };
  } catch (error: unknown) {
    return { error: error as SmtpClientError };
  } finally {
    transport.close();
  }
}

/** Conversation SMTP brute : ce qu'aucun client de haut niveau ne laisse voir. */
class SmtpProbe {
  private buffer = '';
  private lines: string[] = [];
  private readonly queue: string[] = [];
  private waiting: ((reply: string) => void) | null = null;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consume(chunk));
  }

  static async greet(port: number): Promise<SmtpProbe> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const created = new Socket();
      created.once('error', reject);
      created.connect(port, HOST, () => resolve(created));
    });
    const probe = new SmtpProbe(socket);

    await probe.read();

    return probe;
  }

  send(command: string): Promise<string> {
    this.socket.write(`${command}\r\n`);

    return this.read();
  }

  /** Écrit sans attendre de réponse (corps du DATA). */
  write(payload: string): void {
    this.socket.write(payload);
  }

  end(): void {
    this.socket.destroy();
  }

  private read(): Promise<string> {
    const ready = this.queue.shift();

    if (ready !== undefined) {
      return Promise.resolve(ready);
    }

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;

    let index = this.buffer.indexOf('\r\n');

    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);

      // Une réponse s'achève sur « ddd texte » ; « ddd-texte » est une
      // continuation (RFC 5321 §4.2.1).
      if (/^\d{3} /.test(line)) {
        const reply = this.lines.join('\n');
        this.lines = [];
        const waiting = this.waiting;

        if (waiting) {
          this.waiting = null;
          waiting(reply);
        } else {
          this.queue.push(reply);
        }
      }

      index = this.buffer.indexOf('\r\n');
    }
  }
}

/** Argument d'`AUTH PLAIN` (RFC 4616 : `\0utilisateur\0secret`). */
function authPlain(): string {
  return Buffer.from(`\0${USERNAME}\0${secret.password}`, 'utf8').toString(
    'base64',
  );
}

describe('Relais SMTP — pipeline de bout en bout (B6/S7)', () => {
  let relay: Relay;
  let logSpies: jest.SpyInstance[];

  beforeAll(() => {
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterAll(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  beforeEach(async () => {
    relay = await startRelay();
  });

  afterEach(async () => {
    await stopRelay(relay);
  });

  /** Le seul job déposé, typé. */
  function onlyJob(): EmailSendJobData {
    expect(relay.queue.add).toHaveBeenCalledTimes(1);

    return relay.queue.add.mock.calls[0][1];
  }

  // ─── (a) message accepté ────────────────────────────────────────────────
  describe('(a) un message accepté', () => {
    let result: SendResult;

    beforeEach(async () => {
      result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: Awa Diallo <${CLIENT_FROM}>`,
            'To: client@exemple.gn',
            'Subject: Votre commande est prête',
            'Content-Type: text/plain; charset=utf-8',
          ],
          'Bonjour, votre commande vous attend.',
        ),
      });
    });

    it('répond 250 2.0.0 avec l’identifiant public de la ligne créée', () => {
      expect(result.error).toBeUndefined();
      expect(relay.store.emails).toHaveLength(1);
      // Statut étendu écrit par nos soins : `smtp-server` ne transmet pas
      // celui que l'application choisit (voir `smtp-reply.adapter.ts`).
      expect(result.response).toMatch(/^250 2\.0\.0 /);
      expect(result.response).toContain(relay.store.emails[0].publicId);
    });

    it('trace la ligne sur le canal SMTP, avec l’identifiant de la session', () => {
      expect(relay.store.emails[0]).toMatchObject({
        userId: USER_ID,
        channel: EmailChannel.SMTP,
        smtpCredentialId: CREDENTIAL_ID,
        status: EmailStatus.QUEUED,
        fromAddress: `Awa Diallo <${CLIENT_FROM}>`,
        toAddress: 'client@exemple.gn',
        subject: 'Votre commande est prête',
        // Un envoi SMTP est un envoi **client** ordinaire : compté dans la
        // réputation, le quota et le journal, jamais exempté comme `sendSystem`.
        system: false,
      });
    });

    it('débite exactement un crédit', () => {
      expect(relay.store.sendDebits).toEqual([
        {
          userId: USER_ID,
          delta: -1,
          reason: 'SEND',
          reference: relay.store.emails[0].publicId,
        },
      ]);
    });

    it('dépose un seul job « raw », idempotent sur l’identifiant public', () => {
      const publicId = relay.store.emails[0].publicId;

      expect(relay.queue.add).toHaveBeenCalledWith(
        EMAIL_SEND_JOB,
        expect.objectContaining({ emailId: 'email_1', kind: 'raw' }),
        expect.objectContaining({
          jobId: publicId,
          removeOnFail: { age: FAILED_EMAIL_JOB_RETENTION_SECONDS },
        }),
      );

      const job = onlyJob();
      expect(job.kind).toBe('raw');
      // Le message part avec ses octets d'origine : on ne recompose rien.
      expect(job).toHaveProperty(
        'raw',
        expect.stringContaining('Bonjour, votre commande vous attend.'),
      );
    });
  });

  // ─── (b) éventail multi-destinataires ───────────────────────────────────
  it('(b) éventaille un message vers 3 destinataires : 3 lignes, 3 crédits, 3 jobs', async () => {
    const recipients = [
      'client@exemple.gn',
      'compta@exemple.gn',
      'archive@exemple.gn',
    ];

    const result = await send(relay.port, {
      to: recipients,
      raw: mime(
        [
          `From: ${CLIENT_FROM}`,
          'To: client@exemple.gn',
          'Cc: compta@exemple.gn',
          'Subject: Facture 2026-08',
        ],
        'Ci-joint votre facture.',
      ),
    });

    expect(result.error).toBeUndefined();
    expect(relay.store.emails.map((row) => row.toAddress)).toEqual(recipients);
    expect(relay.store.sendDebits).toHaveLength(3);
    expect(relay.queue.add).toHaveBeenCalledTimes(3);

    // Une seule réponse SMTP couvre les trois issues, et les nomme toutes.
    for (const row of relay.store.emails) {
      expect(result.response).toContain(row.publicId);
      expect(result.response).toContain(row.toAddress);
    }

    // Chaque destinataire a sa ligne, son crédit et son job — l'équivalent
    // exact de trois appels API, aucune règle diluée.
    const jobIds = relay.queue.add.mock.calls.map((call) => call[2].jobId);
    expect(new Set(jobIds).size).toBe(3);
    expect(jobIds.sort()).toEqual(
      relay.store.emails.map((row) => row.publicId).sort(),
    );
  });

  // ─── (c) liste de suppression ───────────────────────────────────────────
  it('(c) accepte en 250 un destinataire sur liste de suppression, sans débit ni file', async () => {
    relay.store.suppressions.push({
      address: 'bloque@exemple.gn',
      userId: USER_ID,
    });

    const result = await send(relay.port, {
      to: 'bloque@exemple.gn',
      raw: mime(
        [`From: ${CLIENT_FROM}`, 'Subject: Relance'],
        'Votre facture est en attente.',
      ),
    });

    expect(result.error).toBeUndefined();
    expect(result.response).toContain('250');
    // Le code dit « pris en charge », le texte dit la vérité (A9).
    expect(result.response).toContain('liste de suppression');
    expect(result.response).toContain(relay.store.emails[0].publicId);

    expect(relay.store.emails).toHaveLength(1);
    expect(relay.store.emails[0]).toMatchObject({
      status: EmailStatus.SUPPRESSED,
      channel: EmailChannel.SMTP,
      smtpCredentialId: CREDENTIAL_ID,
    });

    expect(relay.store.sendDebits).toHaveLength(0);
    expect(relay.queue.add).not.toHaveBeenCalled();
  });

  // ─── (d) From d'en-tête sur un domaine non vérifié ──────────────────────
  it('(d) refuse en 550 un From d’en-tête sur un domaine non vérifié, sans créer de ligne', async () => {
    const result = await send(relay.port, {
      // L'enveloppe, elle, est irréprochable : c'est bien l'en-tête `From:`
      // qui fait foi (§4.3), et c'est lui que SES lirait pour signer.
      envelopeFrom: CLIENT_FROM,
      to: 'client@exemple.gn',
      raw: mime(
        ['From: contact@domaine-d-un-tiers.gn', 'Subject: Usurpation'],
        'Ce message ne doit jamais partir.',
      ),
    });

    expect(result.error?.responseCode).toBe(
      SMTP_REPLY_DOMAIN_NOT_VERIFIED.code,
    );
    expect(result.error?.responseCode).toBe(550);
    expect(relay.store.emails).toHaveLength(0);
    expect(relay.store.sendDebits).toHaveLength(0);
    expect(relay.queue.add).not.toHaveBeenCalled();
  });

  // ─── (e) bac à sable vers un tiers ──────────────────────────────────────
  it('(e) refuse en 550 un envoi de l’adresse de test vers un tiers (le bac à sable traverse le canal SMTP)', async () => {
    const result = await send(relay.port, {
      envelopeFrom: TEST_FROM,
      to: 'inconnu@exemple.gn',
      raw: mime(
        [`From: Zendou <${TEST_FROM}>`, 'Subject: Essai'],
        'Message de test.',
      ),
    });

    expect(result.error?.responseCode).toBe(
      SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED.code,
    );
    expect(result.error?.responseCode).toBe(550);
    expect(relay.store.emails).toHaveLength(0);
  });

  it('(e bis) … et l’accepte vers l’adresse du compte, qui est la seule autorisée', async () => {
    const result = await send(relay.port, {
      envelopeFrom: TEST_FROM,
      to: USER_EMAIL,
      raw: mime(
        [`From: Zendou <${TEST_FROM}>`, 'Subject: Essai'],
        'Message de test.',
      ),
    });

    expect(result.error).toBeUndefined();
    expect(relay.store.emails).toHaveLength(1);
    // Un envoi de test n'est rattaché à aucun `Domain` du client.
    expect(relay.store.emails[0].domainId).toBeNull();
    expect(relay.store.emails[0].channel).toBe(EmailChannel.SMTP);
  });

  // ─── (f) retrait du Bcc ─────────────────────────────────────────────────
  it('(f) retire le Bcc des octets transmis, sans toucher au corps', async () => {
    const body = 'Facture en pièce jointe.';
    const result = await send(relay.port, {
      to: ['client@exemple.gn'],
      raw: mime(
        [
          `From: ${CLIENT_FROM}`,
          'To: client@exemple.gn',
          'Bcc: espion@exemple.gn',
          'Sender: autre@exemple.gn',
          'Subject: Facture',
        ],
        body,
      ),
    });

    expect(result.error).toBeUndefined();

    const job = onlyJob();
    expect(job.kind).toBe('raw');

    const raw = (job as { raw: string }).raw;
    // Sans ce retrait, les adresses en copie cachée fuiteraient chez tous les
    // destinataires (§4.3).
    expect(raw).not.toContain('espion@exemple.gn');
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toMatch(/^Sender:/im);
    // Les en-têtes légitimes et le corps, eux, sont intacts.
    expect(raw).toContain('To: client@exemple.gn');
    expect(raw).toContain('Subject: Facture');
    expect(raw).toContain(body);
  });

  // ─── (g) plafond de destinataires ───────────────────────────────────────
  it('(g) refuse le 11ᵉ destinataire en 452 et le compte comme refus (anti-moissonnage)', async () => {
    const refused = jest.spyOn(relay.throttle, 'recordRefusedRecipient');
    const recipients = Array.from(
      { length: 11 },
      (_unused, index) => `client${index}@exemple.gn`,
    );

    const result = await send(relay.port, {
      to: recipients,
      raw: mime([`From: ${CLIENT_FROM}`, 'Subject: Diffusion'], 'Bonjour.'),
    });

    expect(result.error).toBeUndefined();
    expect(result.rejectedErrors?.map((error) => error.responseCode)).toEqual([
      SMTP_REPLY_TOO_MANY_RECIPIENTS.code,
    ]);
    expect(result.rejectedErrors?.[0].responseCode).toBe(452);

    // Le plafond porte bien sur le message : les dix premiers sont servis.
    expect(relay.store.emails).toHaveLength(10);
    expect(relay.store.sendDebits).toHaveLength(10);
    expect(refused).toHaveBeenCalledTimes(1);

    refused.mockRestore();
  });

  it('(g bis) refuse en 452 le destinataire que le solde ne couvre plus', async () => {
    // Deux crédits, trois destinataires : les deux premiers sont finançables,
    // le troisième ne l'est pas. Mieux vaut le refuser que d'accepter un
    // message qu'on ne pourrait honorer qu'aux deux tiers (§4.7).
    relay.store.credits.length = 0;
    relay.store.credits.push({
      userId: USER_ID,
      delta: 2,
      reason: 'TOPUP',
      reference: null,
    });

    const result = await send(relay.port, {
      to: ['client@exemple.gn', 'compta@exemple.gn', 'archive@exemple.gn'],
      raw: mime([`From: ${CLIENT_FROM}`, 'Subject: Facture'], 'Bonjour.'),
    });

    expect(result.error).toBeUndefined();
    // 452 et non 450 : le message part quand même vers les destinataires
    // finançables, et le MTA du client ne rejouera que celui qui a été refusé.
    expect(result.rejectedErrors?.map((error) => error.responseCode)).toEqual([
      SMTP_REPLY_TOO_MANY_RECIPIENTS.code,
    ]);
    expect(relay.store.emails).toHaveLength(2);
    expect(relay.store.sendDebits).toHaveLength(2);
  });

  // ─── (h) contenu non convertible en UTF-8 ───────────────────────────────
  it('(h) refuse en 554 un contenu non UTF-8, avec un message français qui dit quoi faire', async () => {
    // `0xFF` n'est une séquence UTF-8 valide dans aucun contexte : le message
    // ne survivrait pas à la sérialisation JSON du job.
    const raw = Buffer.concat([
      Buffer.from(
        `From: ${CLIENT_FROM}\r\nSubject: Facture\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nMontant du `,
        'utf8',
      ),
      Buffer.from([0xff, 0xe9, 0x0d, 0x0a]),
    ]);

    const result = await send(relay.port, { to: 'client@exemple.gn', raw });

    expect(result.error?.responseCode).toBe(SMTP_REPLY_RAW_NOT_UTF8.code);
    expect(result.error?.responseCode).toBe(554);
    expect(result.error?.response).toContain('UTF-8');
    expect(result.error?.response).toContain('quoted-printable');
    expect(relay.store.emails).toHaveLength(0);
    expect(relay.queue.add).not.toHaveBeenCalled();
  });

  // ─── (i) invariant du §4.8 ──────────────────────────────────────────────
  describe('(i) invariant §4.8 — un contrôle anticipé neutralisé ne contourne rien', () => {
    /**
     * La preuve centrale du chantier. On **désarme délibérément** le contrôle
     * anticipé du `MAIL FROM` — comme le ferait une régression, un refactor
     * maladroit ou un appelant futur qui l'oublierait — et on vérifie que le
     * refus tombe quand même, en fin de `DATA`, parce que la décision qui fait
     * foi est celle de `accept()`.
     */
    it('un compte suspendu reste refusé même si le contrôle anticipé laisse passer', async () => {
      relay.store.userRow.status = UserStatus.SUSPENDED;
      const precheck = jest
        .spyOn(relay.emails, 'precheckSmtpEnvelope')
        .mockResolvedValue(undefined);

      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime([`From: ${CLIENT_FROM}`, 'Subject: Malgré tout'], 'Bonjour.'),
      });

      // Le contrôle anticipé a bien été neutralisé : il a été appelé, et il
      // n'a rien refusé — la conversation est allée jusqu'à DATA.
      expect(precheck).toHaveBeenCalled();
      expect(result.error?.responseCode).toBe(
        SMTP_REPLY_ACCOUNT_SUSPENDED.code,
      );
      expect(result.error?.responseCode).toBe(550);
      expect(relay.store.emails).toHaveLength(0);
      expect(relay.store.sendDebits).toHaveLength(0);
      expect(relay.queue.add).not.toHaveBeenCalled();

      precheck.mockRestore();
    });

    it('un solde épuisé reste refusé même si les deux contrôles anticipés laissent passer', async () => {
      relay.store.credits.length = 0;
      const envelope = jest
        .spyOn(relay.emails, 'precheckSmtpEnvelope')
        .mockResolvedValue(undefined);
      const recipients = jest
        .spyOn(relay.emails, 'precheckSmtpRecipients')
        .mockResolvedValue(undefined);

      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime([`From: ${CLIENT_FROM}`, 'Subject: Sans crédit'], 'Bonjour.'),
      });

      expect(envelope).toHaveBeenCalled();
      expect(recipients).toHaveBeenCalled();
      // Temporaire (A10) : le MTA du client relivrera après recharge.
      expect(result.error?.responseCode).toBe(
        SMTP_REPLY_INSUFFICIENT_CREDITS.code,
      );
      expect(result.error?.responseCode).toBe(450);
      expect(relay.store.emails).toHaveLength(0);

      envelope.mockRestore();
      recipients.mockRestore();
    });
  });

  // ─── Sujet (§4.6) ───────────────────────────────────────────────────────
  describe('sujet du journal (§4.6)', () => {
    it.each([
      ['absent', [`From: ${CLIENT_FROM}`]],
      ['vide', [`From: ${CLIENT_FROM}`, 'Subject:']],
    ])(
      'inscrit « (sans objet) » quand le sujet est %s',
      async (_l, headers) => {
        await send(relay.port, {
          to: 'client@exemple.gn',
          raw: mime(headers, 'Bonjour.'),
        });

        expect(relay.store.emails[0].subject).toBe(SUBJECT_ABSENT_LABEL);
      },
    );

    it('décode les mots encodés RFC 2047 et tronque à 300 caractères pour le stockage seulement', async () => {
      const long = 'é'.repeat(400);
      const encoded = `=?UTF-8?B?${Buffer.from(long, 'utf8').toString('base64')}?=`;

      await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime([`From: ${CLIENT_FROM}`, `Subject: ${encoded}`], 'Bonjour.'),
      });

      expect(relay.store.emails[0].subject).toBe('é'.repeat(300));

      // Le vrai en-tête, lui, part intact : en Raw, `Email.subject` n'est plus
      // qu'un champ de journal.
      const job = onlyJob();
      expect((job as { raw: string }).raw).toContain(encoded);
    });
  });

  // ─── MIME invalide ──────────────────────────────────────────────────────
  it('refuse en 554 un message à deux en-têtes From (ambiguïté exploitable, §4.3)', async () => {
    const result = await send(relay.port, {
      to: 'client@exemple.gn',
      raw: mime(
        [
          `From: ${CLIENT_FROM}`,
          'From: contact@domaine-d-un-tiers.gn',
          'Subject: Deux expéditeurs',
        ],
        'Bonjour.',
      ),
    });

    expect(result.error?.responseCode).toBe(SMTP_REPLY_MIME_INVALID.code);
    expect(result.error?.responseCode).toBe(554);
    expect(relay.store.emails).toHaveLength(0);
  });

  it('retient le From de l’enveloppe quand le message n’en porte pas', async () => {
    await send(relay.port, {
      envelopeFrom: CLIENT_FROM,
      to: 'client@exemple.gn',
      raw: mime(['Subject: Sans en-tête From'], 'Bonjour.'),
    });

    expect(relay.store.emails[0].fromAddress).toBe(CLIENT_FROM);
  });

  // ─── (f) Reply-To : la règle du From, appliquée à l'adresse de réponse ──
  describe('(f) l’en-tête Reply-To subit la règle du domaine vérifié (E1)', () => {
    it('refuse en 550 5.7.1 un Reply-To sur le domaine d’un tiers, sans créer de ligne ni débiter', async () => {
      const result = await send(relay.port, {
        // Tout le reste est irréprochable : enveloppe et `From:` sur le
        // domaine vérifié du client. Seule l'adresse de réponse détourne la
        // conversation vers un domaine qui n'est pas le sien.
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            'Reply-To: pirate@autre-domaine.gn',
            'Subject: Détournement des réponses',
          ],
          'Ce message ne doit jamais partir.',
        ),
      });

      expect(result.error?.responseCode).toBe(
        SMTP_REPLY_REPLY_TO_NOT_VERIFIED.code,
      );
      expect(result.error?.responseCode).toBe(550);
      expect(relay.store.emails).toHaveLength(0);
      expect(relay.store.sendDebits).toHaveLength(0);
      expect(relay.queue.add).not.toHaveBeenCalled();
    });

    it('accepte un Reply-To sur un domaine vérifié du compte', async () => {
      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            `Reply-To: Service client <sav@${CLIENT_DOMAIN}>`,
            'Subject: Votre commande',
          ],
          'Bonjour.',
        ),
      });

      expect(result.error).toBeUndefined();
      expect(relay.store.emails).toHaveLength(1);
      expect(relay.store.sendDebits).toHaveLength(1);
    });

    it('n’en réécrit ni n’en retire aucun : les octets transmis portent toujours le Reply-To accepté', async () => {
      await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            `Reply-To: sav@${CLIENT_DOMAIN}`,
            'Subject: Votre commande',
          ],
          'Bonjour.',
        ),
      });

      const job = onlyJob() as { raw: string };
      expect(job.raw).toContain(`Reply-To: sav@${CLIENT_DOMAIN}`);
    });

    it('refuse tout le message dès la première adresse fautive d’un Reply-To qui en porte plusieurs', async () => {
      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            `Reply-To: sav@${CLIENT_DOMAIN}, pirate@autre-domaine.gn`,
            'Subject: Une bonne, une mauvaise',
          ],
          'Bonjour.',
        ),
      });

      expect(result.error?.responseCode).toBe(550);
      expect(relay.store.emails).toHaveLength(0);
      expect(relay.store.sendDebits).toHaveLength(0);
    });

    it('refuse en 501 5.1.7 un Reply-To illisible', async () => {
      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            'Reply-To: pas-une-adresse',
            'Subject: Adresse de réponse illisible',
          ],
          'Bonjour.',
        ),
      });

      expect(result.error?.responseCode).toBe(
        SMTP_REPLY_REPLY_TO_UNREADABLE.code,
      );
      expect(result.error?.responseCode).toBe(501);
      expect(relay.store.emails).toHaveLength(0);
    });

    it('refuse en 554 un message à deux en-têtes Reply-To (même ambiguïté que deux From)', async () => {
      const result = await send(relay.port, {
        to: 'client@exemple.gn',
        raw: mime(
          [
            `From: ${CLIENT_FROM}`,
            `Reply-To: sav@${CLIENT_DOMAIN}`,
            'Reply-To: pirate@autre-domaine.gn',
            'Subject: Deux adresses de réponse',
          ],
          'Bonjour.',
        ),
      });

      expect(result.error?.responseCode).toBe(SMTP_REPLY_MIME_INVALID.code);
      expect(result.error?.responseCode).toBe(554);
      expect(relay.store.emails).toHaveLength(0);
      expect(relay.store.sendDebits).toHaveLength(0);
    });
  });

  // ─── Câblage de l'anti-abus (S9) ────────────────────────────────────────
  describe('anti-abus (S9) branché aux bonnes étapes', () => {
    it('applique la rafale et le plafond de messages au MAIL FROM, et compte un seul message par éventail', async () => {
      const burst = jest.spyOn(relay.throttle, 'assertSendBurstWithinLimit');
      const messageCount = jest.spyOn(
        relay.throttle,
        'assertMessageCountWithinLimit',
      );
      const recorded = jest.spyOn(relay.throttle, 'recordMessage');

      await send(relay.port, {
        to: ['client@exemple.gn', 'compta@exemple.gn'],
        raw: mime([`From: ${CLIENT_FROM}`, 'Subject: Facture'], 'Bonjour.'),
      });

      // Comptée par **utilisateur**, jamais par IP (NAT opérateur guinéen, §5).
      expect(burst).toHaveBeenCalledWith(USER_ID);
      expect(messageCount).toHaveBeenCalledTimes(1);
      // Plafond de conversation, pas de facturation : deux destinataires, deux
      // crédits, mais **un** message sur la connexion.
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(relay.store.sendDebits).toHaveLength(2);

      burst.mockRestore();
      messageCount.mockRestore();
      recorded.mockRestore();
    });
  });

  // ─── MAIL FROM : contrôles anticipés ────────────────────────────────────
  it('refuse en 550 une enveloppe sur un domaine non vérifié, avant tout téléversement', async () => {
    const result = await send(relay.port, {
      envelopeFrom: 'contact@domaine-d-un-tiers.gn',
      to: 'client@exemple.gn',
      raw: mime(
        [`From: ${CLIENT_FROM}`, 'Subject: Enveloppe usurpée'],
        'Bonjour.',
      ),
    });

    expect(result.error?.responseCode).toBe(550);
    expect(relay.store.emails).toHaveLength(0);
  });

  /**
   * Adresses que `smtp-server` accepte syntaxiquement mais que le validateur
   * de Zandou (`parseEmailAddress`, source unique) refuse : un domaine sans
   * TLD n'est pas routable. C'est le seul moyen d'atteindre **nos** 501 — une
   * adresse franchement malformée (`<pas-une-adresse>`) est refusée par la
   * bibliothèque avant que nos handlers ne soient appelés.
   */
  it('refuse en 501 5.1.7 une enveloppe que le validateur maison rejette', async () => {
    const probe = await SmtpProbe.greet(relay.port);

    try {
      await probe.send('EHLO client.test');
      await probe.send(`AUTH PLAIN ${authPlain()}`);
      const reply = await probe.send('MAIL FROM:<contact@localhost>');

      expect(reply).toMatch(/^501 5\.1\.7 /);
      expect(relay.store.emails).toHaveLength(0);
    } finally {
      probe.end();
    }
  });

  it('refuse en 501 5.1.3 un destinataire que le validateur maison rejette', async () => {
    const refused = jest.spyOn(relay.throttle, 'recordRefusedRecipient');
    const probe = await SmtpProbe.greet(relay.port);

    try {
      await probe.send('EHLO client.test');
      await probe.send(`AUTH PLAIN ${authPlain()}`);
      await probe.send(`MAIL FROM:<${CLIENT_FROM}>`);
      const reply = await probe.send('RCPT TO:<client@localhost>');

      expect(reply).toMatch(/^501 5\.1\.3 /);
      // Tout refus de destinataire nourrit le compteur anti-moissonnage (§5).
      expect(refused).toHaveBeenCalledTimes(1);
    } finally {
      probe.end();
      refused.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Taille : annonce EHLO, refus sur `SIZE=`, et refus pendant le flux
// ─────────────────────────────────────────────────────────────────────────────

describe('Relais SMTP — plafond de taille (§4.5)', () => {
  let relay: Relay;
  let logSpies: jest.SpyInstance[];

  /** Petit plafond : le dépassement se prouve sans transférer 10 Mo. */
  const LIMIT = 4_096;

  beforeAll(async () => {
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    relay = await startRelay({ SMTP_MAX_MESSAGE_BYTES: LIMIT });
  });

  afterAll(async () => {
    await stopRelay(relay);
    logSpies.forEach((spy) => spy.mockRestore());
  });

  it('annonce SIZE avec sa valeur dans l’EHLO — le client sait avant d’envoyer', async () => {
    const probe = await SmtpProbe.greet(relay.port);

    try {
      const reply = await probe.send('EHLO client.test');

      expect(reply).toContain(`SIZE ${LIMIT}`);
    } finally {
      probe.end();
    }
  });

  it('refuse en 552 un SIZE annoncé au-dessus du plafond, dès le MAIL FROM', async () => {
    const probe = await SmtpProbe.greet(relay.port);

    try {
      await probe.send('EHLO client.test');
      await probe.send(`AUTH PLAIN ${authPlain()}`);
      const reply = await probe.send(
        `MAIL FROM:<${CLIENT_FROM}> SIZE=${LIMIT * 10}`,
      );

      expect(reply).toMatch(/^552 /);
      expect(relay.store.emails).toHaveLength(0);
    } finally {
      probe.end();
    }
  });

  it('refuse en 552 un message trop gros dont le client a tu la taille', async () => {
    const probe = await SmtpProbe.greet(relay.port);

    try {
      await probe.send('EHLO client.test');
      await probe.send(`AUTH PLAIN ${authPlain()}`);
      // Aucun `SIZE=` : le client ment par omission. Seule la mesure du flux
      // peut alors le rattraper.
      await probe.send(`MAIL FROM:<${CLIENT_FROM}>`);
      await probe.send('RCPT TO:<client@exemple.gn>');
      await probe.send('DATA');

      probe.write(`From: ${CLIENT_FROM}\r\nSubject: Volumineux\r\n\r\n`);
      probe.write(`${'x'.repeat(LIMIT * 2)}\r\n`);
      const reply = await probe.send('.');

      expect(reply).toMatch(/^552 5\.3\.4 /);
      expect(reply).toContain(SMTP_REPLY_SIZE_EXCEEDED.message);
      expect(relay.store.emails).toHaveLength(0);
      expect(relay.queue.add).not.toHaveBeenCalled();
    } finally {
      probe.end();
    }
  });
});
