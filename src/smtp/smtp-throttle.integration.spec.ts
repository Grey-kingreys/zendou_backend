import { Socket } from 'net';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { generateSmtpCredentialSecret } from '../smtp-credentials';
import { FakeThrottleRedis } from './fixtures/fake-throttle-redis';
import { SMTP_IP_LIMITS_DISABLED_MESSAGE } from './smtp-relay.constants';
import {
  SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
  SMTP_REPLY_TOO_MANY_CONNECTIONS,
} from './smtp-reply';
import { formatSmtpReplyLine } from './smtp-reply.adapter';
import { SmtpAuthService } from './smtp-auth.service';
import { SmtpServerService } from './smtp-server.service';
import {
  SMTP_REPLY_TOO_MANY_AUTH_FAILURES,
  SMTP_THROTTLE_REDIS,
} from './smtp-throttle.constants';
import { SmtpThrottleService } from './smtp-throttle.service';

/**
 * Anti-abus SMTP de bout en bout, **dans le processus de test**, sur un port
 * éphémère (B6/S9 — §7 du plan).
 *
 * Le service anti-abus est le vrai ; seul Redis est doublé
 * (`FakeThrottleRedis`, qui compte réellement). Le client, lui, est un socket
 * TCP nu qui parle SMTP à la main — et non `nodemailer` comme dans la suite
 * S5 : ce qu'on doit prouver ici est qu'**une même connexion** encaisse
 * plusieurs échecs d'AUTH puis se fait fermer, or un client de haut niveau
 * rouvre et masque exactement ce qu'on mesure.
 */

jest.setTimeout(30_000);

const HOST = '127.0.0.1';

/** Conversation SMTP brute sur une seule connexion. */
class SmtpProbe {
  private buffer = '';
  private lines: string[] = [];
  private readonly queue: string[] = [];
  private waiting: ((reply: string) => void) | null = null;
  private ended = false;
  private readonly endWaiters: (() => void)[] = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consume(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  static connect(port: number): Promise<SmtpProbe> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.once('error', reject);
      socket.connect(port, HOST, () => resolve(new SmtpProbe(socket)));
    });
  }

  /** Prochaine réponse complète (les continuations `250-` sont regroupées). */
  read(): Promise<string> {
    const ready = this.queue.shift();

    if (ready !== undefined) {
      return Promise.resolve(ready);
    }

    if (this.ended) {
      return Promise.resolve('');
    }

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Envoie une commande et rend la réponse du serveur. */
  send(command: string): Promise<string> {
    this.socket.write(`${command}\r\n`);

    return this.read();
  }

  /** Se résout quand le serveur a fermé le socket. */
  whenClosed(): Promise<void> {
    if (this.ended) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.endWaiters.push(resolve));
  }

  get closed(): boolean {
    return this.ended;
  }

  end(): void {
    this.socket.destroy();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;

    let index = this.buffer.indexOf('\r\n');

    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);

      // Une réponse s'achève sur une ligne « ddd texte » ; « ddd-texte » est
      // une continuation (RFC 5321 §4.2.1).
      if (/^\d{3} /.test(line)) {
        const reply = this.lines.join('\n');
        this.lines = [];
        this.deliver(reply);
      }

      index = this.buffer.indexOf('\r\n');
    }
  }

  private deliver(reply: string): void {
    const waiting = this.waiting;

    if (waiting) {
      this.waiting = null;
      waiting(reply);
      return;
    }

    this.queue.push(reply);
  }

  private finish(): void {
    this.ended = true;

    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = null;
      waiting('');
    }

    this.endWaiters.splice(0).forEach((resolve) => resolve());
  }
}

/** Argument de `AUTH PLAIN` (RFC 4616 : `\0utilisateur\0secret`). */
function authPlain(username: string, secret: string): string {
  return Buffer.from(`\0${username}\0${secret}`, 'utf8').toString('base64');
}

/** Ouvre une connexion, lit la bannière et présente `EHLO`. */
async function greet(port: number): Promise<SmtpProbe> {
  const probe = await SmtpProbe.connect(port);
  await probe.read();
  await probe.send('EHLO client.test');

  return probe;
}

const valid = generateSmtpCredentialSecret();

const credential = {
  id: 'smtpcred_valide',
  username: 'zdu_valide',
  secretHash: valid.passwordHash,
  revokedAt: null,
  user: {
    id: 'user_actif',
    email: 'aissatou@example.com',
    name: 'Aïssatou Diallo',
    company: null,
    declaredUsage: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    dailySendLimit: 100,
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
};

interface Relay {
  moduleRef: TestingModule;
  service: SmtpServerService;
  throttle: SmtpThrottleService;
  redis: FakeThrottleRedis;
  port: number;
}

async function startRelay(
  overrides: Record<string, unknown>,
): Promise<{ relay: Relay; startupWarnings: string[] }> {
  const redis = new FakeThrottleRedis();
  const config: Record<string, unknown> = {
    NODE_ENV: 'test',
    SMTP_RELAY_ENABLED: true,
    SMTP_PORTS_STARTTLS: [0],
    SMTP_PORTS_TLS: [],
    SMTP_BIND_ADDRESS: HOST,
    SMTP_MAX_CLIENTS: 50,
    SMTP_SOCKET_TIMEOUT_MS: 10_000,
    SMTP_CLOSE_TIMEOUT_MS: 1_000,
    ...overrides,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SmtpServerService,
      SmtpAuthService,
      SmtpThrottleService,
      { provide: SMTP_THROTTLE_REDIS, useValue: redis.asRedis() },
      {
        provide: ConfigService,
        useValue: { get: (key: string) => config[key] },
      },
      {
        provide: PrismaService,
        useValue: {
          smtpCredential: {
            findUnique: ({ where }: { where: { username: string } }) =>
              Promise.resolve(
                where.username === credential.username ? credential : null,
              ),
            update: () => Promise.resolve(credential),
          },
        },
      },
    ],
  }).compile();

  const service = moduleRef.get(SmtpServerService);
  const startupWarnings: string[] = [];
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((...args: unknown[]) => {
      startupWarnings.push(args.map(String).join(' '));
    });

  await service.onModuleInit();
  warn.mockRestore();

  return {
    relay: {
      moduleRef,
      service,
      throttle: moduleRef.get(SmtpThrottleService),
      redis,
      port: service.listeningPorts[0],
    },
    startupWarnings,
  };
}

async function stopRelay(relay: Relay): Promise<void> {
  await relay.service.onModuleDestroy();
  await relay.moduleRef.close();
}

// ───────────────────────────────────────────────────────────────────────────
// (b) — N+1 échecs d'AUTH sur une connexion → 421 puis socket fermé
// ───────────────────────────────────────────────────────────────────────────

describe('Anti-abus SMTP en processus — bourrinage d’authentification', () => {
  let relay: Relay;
  let logSpies: jest.SpyInstance[];

  beforeAll(async () => {
    ({ relay } = await startRelay({
      // N = 2 : deux échecs tolérés, le troisième coupe.
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 2,
      SMTP_MAX_CONNECTIONS_PER_IP: 100,
      SMTP_AUTH_STUFFING_USERNAME_THRESHOLD: 3,
    }));
  });

  beforeEach(() => {
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    logSpies.forEach((spy) => spy.mockRestore());
  });

  afterAll(async () => {
    await stopRelay(relay);
  });

  it('rend 535 sur les N premiers échecs, puis 421 et ferme le socket', async () => {
    const probe = await greet(relay.port);

    const first = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );
    const second = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );

    expect(first).toBe(
      formatSmtpReplyLine(SMTP_REPLY_AUTH_INVALID_CREDENTIALS),
    );
    expect(second).toBe(first);
    expect(probe.closed).toBe(false);

    const third = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );

    expect(third).toBe(formatSmtpReplyLine(SMTP_REPLY_TOO_MANY_AUTH_FAILURES));
    expect(third.startsWith('421 ')).toBe(true);

    // La fermeture n'est pas une politesse : c'est ce qui impose à
    // l'attaquant une poignée de main TCP par groupe de trois essais.
    await probe.whenClosed();
    expect(probe.closed).toBe(true);
  });

  it('repart d’une ardoise propre sur une connexion neuve — aucun compte verrouillé', async () => {
    const probe = await greet(relay.port);

    const refused = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );
    expect(refused.startsWith('535 ')).toBe(true);

    // Le même identifiant s'authentifie normalement juste après : le §5
    // interdit le verrouillage de compte, qui serait un déni de service offert
    // à qui connaît un nom d'utilisateur.
    const accepted = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', valid.password)}`,
    );
    expect(accepted.startsWith('235 ')).toBe(true);

    probe.end();
  });

  it('écrit les compteurs Redis attendus, aux clés littérales du §5', async () => {
    const before = relay.redis.writtenKeys.length;
    const probe = await greet(relay.port);

    await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );
    probe.end();

    const hits = relay.redis.hitCalls
      .map((call) => call.key)
      .filter((key) => key.startsWith('smtp:auth:'));
    const distincts = relay.redis.distinctCalls.map((call) => call.key);

    expect(relay.redis.writtenKeys.length).toBeGreaterThan(before);
    expect(hits).toContain('smtp:auth:fail:ip:127.0.0.1');
    expect(hits).toContain('smtp:auth:fail:user:zdu_valide');
    expect(distincts).toContain('smtp:auth:stuffing:127.0.0.1');
  });

  it('ne compte pas une authentification réussie comme un échec', async () => {
    const probe = await greet(relay.port);
    const before = relay.redis.writtenKeys.filter((key) =>
      key.startsWith('smtp:auth:'),
    ).length;

    const accepted = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', valid.password)}`,
    );
    probe.end();

    expect(accepted.startsWith('235 ')).toBe(true);
    expect(
      relay.redis.writtenKeys.filter((key) => key.startsWith('smtp:auth:'))
        .length,
    ).toBe(before);
  });

  // ─── (d) ─────────────────────────────────────────────────────────────────
  it('ne fait jamais apparaître le secret présenté dans les journaux', async () => {
    const probe = await greet(relay.port);

    // Trois échecs sur trois noms distincts : on traverse le chemin 535 **et**
    // le chemin 421 + alerte de bourrinage, c'est-à-dire toutes les lignes de
    // journal que S9 ajoute. Le secret présenté est le **vrai** secret d'un
    // identifiant existant — le pire cas : s'il devait fuiter quelque part,
    // c'est ici qu'on le verrait.
    for (const username of ['zdu_inconnu', 'zdu_autre', 'zdu_troisieme']) {
      await probe.send(`AUTH PLAIN ${authPlain(username, valid.password)}`);
    }
    await probe.whenClosed();

    const logged = logSpies
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .flat()
      .map((argument) => String(argument))
      .join('\n');

    expect(logged).not.toContain(valid.password);
    // Les noms d'utilisateur et l'IP, eux, sont attendus : le §5 les demande
    // pour compter les échecs par compte et nommer la source.
    expect(logged).toContain('zdu_inconnu');
    expect(logged).toContain('127.0.0.1');
    // Et l'alerte de bourrinage a bien été levée par trois noms distincts.
    expect(logged).toContain('bourrinage d’identifiants SMTP');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) — plafond de connexions par IP → 421 à la connexion
// ───────────────────────────────────────────────────────────────────────────

describe('Anti-abus SMTP en processus — plafond de connexions par IP', () => {
  let relay: Relay;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    ({ relay } = await startRelay({ SMTP_MAX_CONNECTIONS_PER_IP: 2 }));
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    await stopRelay(relay);
  });

  it('accueille les connexions jusqu’au plafond, puis refuse en 421 à la place de la bannière', async () => {
    const accepted: SmtpProbe[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const probe = await SmtpProbe.connect(relay.port);
      expect(await probe.read()).toMatch(/^220 /);
      accepted.push(probe);
    }

    const refused = await SmtpProbe.connect(relay.port);
    const banner = await refused.read();

    // Le client ne voit jamais `220` : la conversation n'a pas lieu.
    expect(banner).toBe(formatSmtpReplyLine(SMTP_REPLY_TOO_MANY_CONNECTIONS));
    expect(banner.startsWith('421 ')).toBe(true);

    await refused.whenClosed();
    expect(refused.closed).toBe(true);

    accepted.forEach((probe) => probe.end());
  });

  it('a écrit le compteur de connexions à la clé littérale smtp:conn:ip:127.0.0.1', () => {
    expect(
      relay.redis.hitCalls.filter(
        (call) => call.key === 'smtp:conn:ip:127.0.0.1',
      ),
    ).toHaveLength(3);
  });

  it('libère les compteurs de connexion à la fermeture', async () => {
    const probe = await SmtpProbe.connect(relay.port);
    await probe.read();
    probe.end();
    await probe.whenClosed();
    // `onClose` est asynchrone côté `smtp-server` (`setImmediate`).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Rien ne prouve mieux la libération que l'état interne : une table qui
    // ne se vide pas serait une fuite mémoire pilotée par l'attaquant.
    expect(
      (relay.throttle as unknown as { connections: Map<string, unknown> })
        .connections.size,
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) — IP source non fiable : limites par IP explicitement désactivées
// ───────────────────────────────────────────────────────────────────────────

describe('Anti-abus SMTP en processus — IP source non fiable (§1.3)', () => {
  let relay: Relay;
  let startupWarnings: string[];
  let logSpies: jest.SpyInstance[];

  beforeAll(async () => {
    ({ relay, startupWarnings } = await startRelay({
      SMTP_IP_LIMITS_ENABLED: false,
      // Des plafonds volontairement minuscules : s'ils s'appliquaient, la
      // deuxième connexion serait refusée et le test le verrait aussitôt.
      SMTP_MAX_CONNECTIONS_PER_IP: 1,
      SMTP_MAX_AUTH_FAILURES_PER_CONNECTION: 2,
    }));
    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterAll(async () => {
    logSpies.forEach((spy) => spy.mockRestore());
    await stopRelay(relay);
  });

  it('avertit au démarrage que les limites par IP sont désactivées', () => {
    expect(startupWarnings.join('\n')).toContain(
      SMTP_IP_LIMITS_DISABLED_MESSAGE,
    );
    expect(startupWarnings.join('\n')).toContain('limites par IP désactivées');
  });

  it('n’écrit aucune clé par IP, et accepte toutes les connexions', async () => {
    const probes: SmtpProbe[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const probe = await SmtpProbe.connect(relay.port);
      expect(await probe.read()).toMatch(/^220 /);
      probes.push(probe);
    }

    probes.forEach((probe) => probe.end());

    // Ni compteur de connexions, ni compteur d'échecs par IP, ni ensemble
    // anti-stuffing : sous le routing mesh Swarm ils compteraient toute la
    // planète sur une seule adresse.
    expect(
      relay.redis.writtenKeys.filter((key) => key.includes(':ip:')),
    ).toEqual([]);
    expect(
      relay.redis.writtenKeys.filter((key) =>
        key.startsWith('smtp:auth:stuffing:'),
      ),
    ).toEqual([]);
  });

  it('garde actives les limites par nom d’utilisateur et par connexion', async () => {
    const probe = await greet(relay.port);

    await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );
    await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );

    const cut = await probe.send(
      `AUTH PLAIN ${authPlain('zdu_valide', 'zd_smtp_mauvais_secret')}`,
    );

    // Le plafond par connexion ne dépend pas de l'IP : il tient debout.
    expect(cut).toBe(formatSmtpReplyLine(SMTP_REPLY_TOO_MANY_AUTH_FAILURES));
    await probe.whenClosed();

    // Et le compteur par nom d'utilisateur continue d'être écrit.
    expect(relay.redis.writtenKeys).toContain('smtp:auth:fail:user:zdu_valide');
  });
});
