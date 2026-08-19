import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { createTransport } from 'nodemailer';
import { MAX_RAW_MESSAGE_BYTES } from '../emails/emails.constants';
import { PrismaService } from '../prisma/prisma.service';
import { generateSmtpCredentialSecret } from '../smtp-credentials';
import { SmtpAuthService } from './smtp-auth.service';
import { SmtpPipelineService } from './smtp-pipeline.service';
import { SMTP_DEFAULT_MAX_RECIPIENTS } from './smtp-relay.constants';
import {
  SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
  SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
  SMTP_REPLY_UNKNOWN_SERVER_ERROR,
} from './smtp-reply';
import { formatSmtpReplyLine } from './smtp-reply.adapter';
import { SmtpServerService } from './smtp-server.service';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * Relais SMTP de bout en bout, **dans le processus de test**, sur un port
 * éphémère, avec un vrai client `nodemailer` en face (§7 du plan B6).
 *
 * Le seul aménagement est `allowInsecureAuth`, activé par le service quand
 * `NODE_ENV === 'test'` : c'est lui qui rend la conversation vérifiable sans
 * certificat. Tout le reste — la mécanique de session de `smtp-server`, le
 * hachage SHA-256 des secrets, le lookup Prisma, les codes de réponse — est le
 * code de production.
 */

jest.setTimeout(30_000);

const HOST = '127.0.0.1';

/** Erreur telle que `nodemailer` la remonte quand le serveur refuse. */
interface SmtpClientError extends Error {
  responseCode?: number;
  response?: string;
}

interface CredentialRow {
  id: string;
  username: string;
  secretHash: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  user: {
    id: string;
    email: string;
    name: string;
    company: string | null;
    declaredUsage: string | null;
    role: UserRole;
    status: UserStatus;
    dailySendLimit: number;
    emailVerifiedAt: Date | null;
    createdAt: Date;
  };
}

function makeUser(id: string, status: UserStatus): CredentialRow['user'] {
  return {
    id,
    email: `${id}@example.com`,
    name: 'Aïssatou Diallo',
    company: null,
    declaredUsage: null,
    role: UserRole.CUSTOMER,
    status,
    dailySendLimit: 100,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Nom d'utilisateur dont le lookup simule une panne de base de données. */
const BROKEN_USERNAME = 'zdu_panne_de_base';

/**
 * Double permissif de l'anti-abus (S9). Cette suite exerce la conversation
 * SMTP de S5 — authentification, oracle d'énumération, open relay — et ouvre
 * une dizaine de connexions dont plusieurs échouent volontairement : la
 * soumettre en plus aux plafonds de S9 mêlerait deux sujets et la rendrait
 * fragile. Les compteurs sont vérifiés par `smtp-throttle.integration.spec.ts`,
 * qui fait tourner le vrai service contre un Redis en mémoire.
 */
const throttleDouble = () => ({
  ipLimitsEnabled: true,
  registerConnection: jest.fn().mockResolvedValue(undefined),
  releaseConnection: jest.fn(),
  recordAuthFailure: jest.fn().mockResolvedValue(undefined),
});

/**
 * Double du pipeline (S7). Cette suite exerce la session et l'AUTH ; la seule
 * conversation qui va au-delà est le `MAIL FROM` anonyme, refusé en `530`
 * **avant** que le pipeline ne soit sollicité. Le tout est vérifié de bout en
 * bout, point d'acceptation compris, par `smtp-pipeline.integration.spec.ts`.
 */
const pipelineDouble = () => ({
  maxMessageBytes: MAX_RAW_MESSAGE_BYTES,
  maxRecipients: SMTP_DEFAULT_MAX_RECIPIENTS,
  mailFrom: jest.fn().mockResolvedValue(undefined),
  rcptTo: jest.fn().mockResolvedValue(undefined),
  data: jest.fn().mockResolvedValue(''),
});

/**
 * Double en mémoire de `PrismaService.smtpCredential`, à sémantique de requête
 * réelle (lookup par `username`, mutation en place) plutôt que réponses
 * pré-programmées : le vrai chemin d'authentification est exercé, hachage
 * compris.
 */
class FakeSmtpCredentialStore {
  private readonly rows = new Map<string, CredentialRow>();

  add(row: CredentialRow): void {
    this.rows.set(row.username, row);
  }

  findUnique = jest.fn(({ where }: { where: { username: string } }) => {
    if (where.username === BROKEN_USERNAME) {
      // Panne franche du côté serveur : sert à prouver la contrepartie n°1 du
      // §1.1 — une exception inattendue devient une réponse temporaire, pas un
      // crash du processus qui emporterait aussi l'API.
      return Promise.reject(new Error('connexion à la base perdue'));
    }

    return Promise.resolve(this.rows.get(where.username) ?? null);
  });

  update = jest.fn(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: { lastUsedAt: Date };
    }) => {
      for (const row of this.rows.values()) {
        if (row.id === where.id) {
          row.lastUsedAt = data.lastUsedAt;
          return Promise.resolve(row);
        }
      }

      return Promise.reject(new Error('identifiant introuvable'));
    },
  );

  byId(id: string): CredentialRow | undefined {
    return [...this.rows.values()].find((row) => row.id === id);
  }
}

/** Tente une authentification et rend l'erreur du serveur, ou `null` si elle réussit. */
async function attemptAuth(
  port: number,
  user: string,
  pass: string,
): Promise<SmtpClientError | null> {
  const transport = createTransport({
    host: HOST,
    port,
    secure: false,
    // Pas de STARTTLS : c'est le canal en clair réservé aux tests, celui que
    // `allowInsecureAuth` autorise.
    ignoreTLS: true,
    auth: { user, pass },
  });

  try {
    await transport.verify();
    return null;
  } catch (error: unknown) {
    return error as SmtpClientError;
  } finally {
    transport.close();
  }
}

describe('Relais SMTP en processus — session et AUTH (B6/S5)', () => {
  let moduleRef: TestingModule;
  let service: SmtpServerService;
  let store: FakeSmtpCredentialStore;
  let port: number;

  const valid = generateSmtpCredentialSecret();
  const revoked = generateSmtpCredentialSecret();
  const suspended = generateSmtpCredentialSecret();

  const config: Record<string, unknown> = {
    NODE_ENV: 'test',
    SMTP_RELAY_ENABLED: true,
    // Port éphémère : aucune infrastructure, aucun conflit avec un autre test.
    SMTP_PORTS_STARTTLS: [0],
    SMTP_PORTS_TLS: [],
    SMTP_BIND_ADDRESS: HOST,
    SMTP_MAX_CLIENTS: 10,
    SMTP_SOCKET_TIMEOUT_MS: 10_000,
    SMTP_CLOSE_TIMEOUT_MS: 1_000,
  };

  beforeAll(async () => {
    store = new FakeSmtpCredentialStore();

    store.add({
      id: 'smtpcred_valide',
      username: 'zdu_valide',
      secretHash: valid.passwordHash,
      revokedAt: null,
      lastUsedAt: null,
      user: makeUser('user_actif', UserStatus.ACTIVE),
    });

    store.add({
      id: 'smtpcred_revoque',
      username: 'zdu_revoque',
      secretHash: revoked.passwordHash,
      revokedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastUsedAt: null,
      user: makeUser('user_revoque', UserStatus.ACTIVE),
    });

    store.add({
      id: 'smtpcred_suspendu',
      username: 'zdu_suspendu',
      secretHash: suspended.passwordHash,
      revokedAt: null,
      lastUsedAt: null,
      user: makeUser('user_suspendu', UserStatus.SUSPENDED),
    });

    moduleRef = await Test.createTestingModule({
      providers: [
        SmtpServerService,
        SmtpAuthService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        { provide: SmtpThrottleService, useValue: throttleDouble() },
        { provide: SmtpPipelineService, useValue: pipelineDouble() },
        { provide: PrismaService, useValue: { smtpCredential: store } },
      ],
    }).compile();

    service = moduleRef.get(SmtpServerService);
    await service.onModuleInit();

    [port] = service.listeningPorts;
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await moduleRef.close();
  });

  it('écoute une seule instance, sur le port éphémère obtenu', () => {
    expect(service.listeningPorts).toHaveLength(1);
    expect(port).toBeGreaterThan(0);
  });

  // ─── (a) ───────────────────────────────────────────────────────────────
  it('authentifie un identifiant valide', async () => {
    const error = await attemptAuth(port, 'zdu_valide', valid.password);

    expect(error).toBeNull();
  });

  it('met à jour lastUsedAt en tâche de fond après une authentification réussie', async () => {
    await attemptAuth(port, 'zdu_valide', valid.password);

    // `void … .catch()` : la mise à jour ne bloque pas la session, on lui
    // laisse donc un tour de boucle avant de l'observer.
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.byId('smtpcred_valide')?.lastUsedAt).toBeInstanceOf(Date);
  });

  // ─── (b) ───────────────────────────────────────────────────────────────
  describe('refus d’authentification — aucun oracle d’énumération (§3.3)', () => {
    let logSpies: jest.SpyInstance[];
    let responses: (SmtpClientError | null)[];

    beforeAll(async () => {
      logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );

      responses = [
        // nom d'utilisateur inconnu
        await attemptAuth(port, 'zdu_inexistant', valid.password),
        // secret faux sur un identifiant existant
        await attemptAuth(port, 'zdu_valide', 'zd_smtp_mauvais_secret'),
        // identifiant révoqué, secret pourtant correct
        await attemptAuth(port, 'zdu_revoque', revoked.password),
      ];
    });

    afterAll(() => {
      logSpies.forEach((spy) => spy.mockRestore());
    });

    it('répond 535 dans les trois cas', () => {
      expect(responses.map((error) => error?.responseCode)).toEqual([
        535, 535, 535,
      ]);
    });

    it('répond exactement le même texte dans les trois cas', () => {
      const texts = responses.map((error) => error?.response);

      // L'égalité mutuelle est la propriété qui compte : distinguer « inconnu »
      // de « mauvais mot de passe » révélerait quels noms d'utilisateur
      // existent.
      expect(new Set(texts).size).toBe(1);
      expect(texts[0]).toBe(
        formatSmtpReplyLine(SMTP_REPLY_AUTH_INVALID_CREDENTIALS),
      );
    });

    it('ne fait jamais apparaître un secret dans les journaux', () => {
      const logged = logSpies
        .flatMap((spy) => spy.mock.calls as unknown[][])
        .flat()
        .map((argument) => String(argument))
        .join('\n');

      expect(logged).not.toContain(valid.password);
      expect(logged).not.toContain(revoked.password);
      expect(logged).not.toContain('zd_smtp_mauvais_secret');
      // Le nom d'utilisateur, lui, est attendu : le §5 le demande pour compter
      // les échecs par compte.
      expect(logged).toContain('zdu_inexistant');
    });
  });

  // ─── (c) ───────────────────────────────────────────────────────────────
  it('refuse MAIL FROM sans authentification (530, pas d’open relay)', async () => {
    const transport = createTransport({
      host: HOST,
      port,
      secure: false,
      ignoreTLS: true,
      // aucun bloc `auth` : la session reste anonyme
    });

    let caught: SmtpClientError | null = null;

    try {
      await transport.sendMail({
        from: 'expediteur@exemple.gn',
        to: 'destinataire@exemple.gn',
        subject: 'Tentative de relais anonyme',
        text: 'Ce message ne doit jamais être accepté.',
      });
    } catch (error: unknown) {
      caught = error as SmtpClientError;
    } finally {
      transport.close();
    }

    expect(caught?.responseCode).toBe(SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH.code);
    expect(caught?.responseCode).toBe(530);
  });

  // ─── (d) ───────────────────────────────────────────────────────────────
  it('laisse un compte SUSPENDED réussir son authentification (§3.3)', async () => {
    const error = await attemptAuth(port, 'zdu_suspendu', suspended.password);

    // Les identifiants sont valides : échouer ici serait un message trompeur.
    // Le refus tombera au MAIL FROM (550 5.7.1), hors périmètre S5.
    expect(error).toBeNull();
  });

  // ─── Contrepartie n°1 du §1.1 ──────────────────────────────────────────
  it('transforme une exception inattendue en 451 sans tuer le processus', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const error = await attemptAuth(port, BROKEN_USERNAME, valid.password);

    expect(error?.responseCode).toBe(SMTP_REPLY_UNKNOWN_SERVER_ERROR.code);
    expect(error?.response).toBe(
      formatSmtpReplyLine(SMTP_REPLY_UNKNOWN_SERVER_ERROR),
    );
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();

    // Le relais répond encore : l'exception n'a rien emporté.
    await expect(attemptAuth(port, 'zdu_valide', valid.password)).resolves.toBe(
      null,
    );
  });
});

describe('Relais SMTP hors test — AUTH refusée sur canal en clair (§3.3)', () => {
  let moduleRef: TestingModule;
  let service: SmtpServerService;
  let port: number;

  const config: Record<string, unknown> = {
    // Hors `test`, `allowInsecureAuth` n'est jamais posé : `smtp-server`
    // refuse alors toute authentification tant que STARTTLS n'a pas été
    // négocié, et notre propre contrôle le double.
    NODE_ENV: 'development',
    SMTP_RELAY_ENABLED: true,
    SMTP_PORTS_STARTTLS: [0],
    SMTP_PORTS_TLS: [],
    SMTP_BIND_ADDRESS: HOST,
    SMTP_MAX_CLIENTS: 10,
    SMTP_SOCKET_TIMEOUT_MS: 10_000,
    SMTP_CLOSE_TIMEOUT_MS: 1_000,
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        SmtpServerService,
        SmtpAuthService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        { provide: SmtpThrottleService, useValue: throttleDouble() },
        { provide: SmtpPipelineService, useValue: pipelineDouble() },
        {
          provide: PrismaService,
          useValue: {
            smtpCredential: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(SmtpServerService);
    await service.onModuleInit();

    [port] = service.listeningPorts;
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await moduleRef.close();
  });

  it('répond 538 à une tentative d’AUTH avant chiffrement', async () => {
    const error = await attemptAuth(port, 'zdu_valide', 'peu importe');

    expect(error?.responseCode).toBe(538);
  });

  it('ne consulte jamais la base pour une AUTH refusée avant chiffrement', () => {
    const prisma = moduleRef.get<{
      smtpCredential: { findUnique: jest.Mock };
    }>(PrismaService);

    expect(prisma.smtpCredential.findUnique).not.toHaveBeenCalled();
  });
});
