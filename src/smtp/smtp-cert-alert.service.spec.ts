import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { EmailsService } from '../emails/emails.service';
import type { SystemEmailPayload } from '../emails/emails.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMTP_CERT_ALERT_MARKER_TTL_MS,
  SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE,
  SMTP_CERT_ALERT_REDIS,
} from './smtp-cert-alert.constants';
import {
  SMTP_CERT_ALERT_CLOCK,
  SMTP_CERT_INSPECTOR,
  type SmtpCertificateSnapshot,
} from './smtp-cert-alert.inspector';
import { SMTP_CERT_ALERT_SCHEDULER } from './smtp-cert-alert.scheduler';
import { SmtpCertAlertService } from './smtp-cert-alert.service';

/**
 * Surveillance du certificat TLS du relais SMTP (B6/H1).
 *
 * **Aucune dépendance à l'heure réelle ni à un vrai certificat** : l'horloge
 * et l'inspecteur sont injectés. Un test qui lirait un certificat sur disque
 * finirait par échouer le jour de son expiration — soit exactement la panne
 * silencieuse que ce module existe pour empêcher, transposée dans la CI.
 *
 * Le double Redis **compte réellement** (`SET NX` refuse la seconde
 * réservation, `DEL` la rend possible à nouveau) plutôt que de rendre des
 * réponses pré-programmées : l'anti-spam ne se vérifie qu'en appelant le
 * service autant de fois qu'un ordonnanceur le ferait.
 */

/** Redis en mémoire réduit aux deux commandes utilisées par le service. */
class FakeAlertRedis {
  readonly entries = new Map<
    string,
    { value: string; ttlMs: number; mode: 'NX' }
  >();
  readonly setCalls: string[] = [];
  readonly delCalls: string[] = [];
  disconnected = false;
  failing = false;

  set = (
    key: string,
    value: string,
    _px: 'PX',
    ttlMs: number,
    mode: 'NX',
  ): Promise<'OK' | null> => {
    this.setCalls.push(key);

    if (this.failing) {
      return Promise.reject(new Error('Redis injoignable'));
    }

    if (this.entries.has(key)) {
      return Promise.resolve(null);
    }

    this.entries.set(key, { value, ttlMs, mode });

    return Promise.resolve('OK');
  };

  del = (key: string): Promise<number> => {
    this.delCalls.push(key);

    if (this.failing) {
      return Promise.reject(new Error('Redis injoignable'));
    }

    return Promise.resolve(this.entries.delete(key) ? 1 : 0);
  };

  disconnect = (): void => {
    this.disconnected = true;
  };

  /** Toutes les clés réservées, dans l'ordre — assertées littéralement. */
  get keys(): string[] {
    return [...this.entries.keys()];
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

/** Planificateur double : enregistre l'installation sans toucher à BullMQ. */
class FakeScheduler {
  readonly started: (() => Promise<void>)[] = [];
  stopped = 0;

  start = (run: () => Promise<void>): Promise<void> => {
    this.started.push(run);
    return Promise.resolve();
  };

  stop = (): Promise<void> => {
    this.stopped += 1;
    return Promise.resolve();
  };

  /** Déclenche le contrôle comme le ferait un job de la tâche répétable. */
  async tick(): Promise<void> {
    for (const run of this.started) {
      await run();
    }
  }
}

const CERT_PATH = '/etc/zendou/tls/fullchain.pem';
const RECIPIENT = 'alertes@zendou.gn';
const ADMIN = 'admin@zendou.gn';

/** Empreinte du certificat en place — un renouvellement en change la valeur. */
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const EXPIRES_AT = new Date('2026-11-12T08:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Instant situé `days` jours (et `hours` heures) avant l'échéance. */
function daysBeforeExpiry(days: number, hours = 0): Date {
  return new Date(EXPIRES_AT.getTime() - days * DAY_MS - hours * 3_600_000);
}

function snapshot(fingerprint = FINGERPRINT_A): SmtpCertificateSnapshot {
  return {
    subjectName: 'smtp.zendou.gn',
    fingerprint,
    expiresAt: EXPIRES_AT,
  };
}

describe('SmtpCertAlertService — surveillance du certificat SMTP (B6/H1)', () => {
  let service: SmtpCertAlertService;
  let redis: FakeAlertRedis;
  let scheduler: FakeScheduler;
  let inspect: jest.Mock<SmtpCertificateSnapshot, [string]>;
  let sendSystem: jest.Mock;
  let findUnique: jest.Mock;
  let env: Record<string, unknown>;
  let clock: Date;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    redis = new FakeAlertRedis();
    scheduler = new FakeScheduler();
    inspect = jest.fn<SmtpCertificateSnapshot, [string]>(() => snapshot());
    sendSystem = jest.fn().mockResolvedValue({ status: 'queued', id: 'e_1' });
    findUnique = jest.fn().mockResolvedValue({ id: 'usr_1' });
    clock = daysBeforeExpiry(7);

    env = {
      SMTP_RELAY_ENABLED: true,
      SMTP_TLS_CERT_PATH: CERT_PATH,
      ALERTS_EMAIL_TO: RECIPIENT,
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function build(): Promise<SmtpCertAlertService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SmtpCertAlertService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: EmailsService, useValue: { sendSystem } },
        { provide: SMTP_CERT_ALERT_REDIS, useValue: redis.asRedis() },
        { provide: SMTP_CERT_INSPECTOR, useValue: inspect },
        { provide: SMTP_CERT_ALERT_CLOCK, useValue: () => clock },
        { provide: SMTP_CERT_ALERT_SCHEDULER, useValue: scheduler },
      ],
    }).compile();

    service = moduleRef.get(SmtpCertAlertService);

    return service;
  }

  /** Démarre le module comme Nest le ferait (contrôle + planification). */
  async function bootstrap(): Promise<void> {
    await (await build()).onApplicationBootstrap();
  }

  /** Le dernier payload passé à `sendSystem`. */
  function lastPayload(): SystemEmailPayload {
    const [payload] = sendSystem.mock.calls.at(-1) as [SystemEmailPayload];

    return payload;
  }

  describe('relais désactivé', () => {
    beforeEach(() => {
      env.SMTP_RELAY_ENABLED = false;
    });

    it('ne planifie aucune tâche et ne lit aucun fichier', async () => {
      await bootstrap();

      expect(scheduler.started).toHaveLength(0);
      expect(inspect).not.toHaveBeenCalled();
    });

    it('n’écrit dans Redis ni n’envoie quoi que ce soit', async () => {
      await bootstrap();

      expect(redis.setCalls).toEqual([]);
      expect(sendSystem).not.toHaveBeenCalled();
    });

    it('ne dépend pas de la présence d’un destinataire', async () => {
      delete env.ALERTS_EMAIL_TO;

      await expect(bootstrap()).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalledWith(
        SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE,
      );
    });
  });

  describe('démarrage', () => {
    it('contrôle immédiatement — un déploiement avec un certificat déjà court alerte tout de suite', async () => {
      clock = daysBeforeExpiry(2);

      await bootstrap();

      expect(inspect).toHaveBeenCalledWith(CERT_PATH);
      expect(sendSystem).toHaveBeenCalledTimes(1);
    });

    it('installe ensuite la tâche répétable', async () => {
      await bootstrap();

      expect(scheduler.started).toHaveLength(1);
    });

    it('démarre malgré un planificateur en échec', async () => {
      scheduler.start = () => Promise.reject(new Error('Redis injoignable'));

      await expect(bootstrap()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    });

    it('ne surveille rien si SMTP_TLS_CERT_PATH est absente (certificat auto-signé de dev)', async () => {
      delete env.SMTP_TLS_CERT_PATH;

      await bootstrap();

      expect(inspect).not.toHaveBeenCalled();
      expect(sendSystem).not.toHaveBeenCalled();
    });
  });

  describe('paliers', () => {
    it.each([
      [45, undefined],
      [31, undefined],
      [30, 'Certificat SMTP : expire dans 30 jours'],
      [20, 'Certificat SMTP : expire dans 20 jours'],
      [14, 'Certificat SMTP : expire dans 14 jours'],
      [7, 'Certificat SMTP : expire dans 7 jours'],
      [3, 'Certificat SMTP : expire dans 3 jours'],
      [1, 'Certificat SMTP : expire dans 1 jour'],
    ])('à %s jours de l’échéance', async (days, subject) => {
      clock = daysBeforeExpiry(days);

      await bootstrap();

      if (subject === undefined) {
        expect(sendSystem).not.toHaveBeenCalled();
        return;
      }

      expect(sendSystem).toHaveBeenCalledTimes(1);
      expect(lastPayload().subject).toBe(subject);
    });

    it('arrondit au plancher : 7 jours et 12 heures restants, c’est le palier 7', async () => {
      clock = daysBeforeExpiry(7, 12);

      await bootstrap();

      expect(lastPayload().subject).toBe(
        'Certificat SMTP : expire dans 7 jours',
      );
    });

    it('n’envoie qu’une seule alerte, même après plusieurs contrôles', async () => {
      clock = daysBeforeExpiry(7);

      await bootstrap();
      await scheduler.tick();
      await scheduler.tick();

      expect(inspect).toHaveBeenCalledTimes(3);
      expect(sendSystem).toHaveBeenCalledTimes(1);
    });

    it('réalerte au palier suivant', async () => {
      clock = daysBeforeExpiry(7);
      await bootstrap();

      clock = daysBeforeExpiry(5);
      await scheduler.tick();
      expect(sendSystem).toHaveBeenCalledTimes(1);

      clock = daysBeforeExpiry(3);
      await scheduler.tick();
      expect(sendSystem).toHaveBeenCalledTimes(2);
      expect(lastPayload().subject).toBe(
        'Certificat SMTP : expire dans 3 jours',
      );

      clock = daysBeforeExpiry(1);
      await scheduler.tick();
      expect(sendSystem).toHaveBeenCalledTimes(3);
      expect(lastPayload().subject).toBe(
        'Certificat SMTP : expire dans 1 jour',
      );
    });

    it('mémorise un palier par clé, empreinte comprise', async () => {
      clock = daysBeforeExpiry(7);
      await bootstrap();

      clock = daysBeforeExpiry(3);
      await scheduler.tick();

      expect(redis.keys).toEqual([
        `smtp-cert-alert:${FINGERPRINT_A}:j7`,
        `smtp-cert-alert:${FINGERPRINT_A}:j3`,
      ]);
    });

    it('pose une durée de vie plus longue que le cycle de renouvellement', async () => {
      await bootstrap();

      expect(redis.entries.get(`smtp-cert-alert:${FINGERPRINT_A}:j7`)).toEqual({
        value: '1',
        ttlMs: SMTP_CERT_ALERT_MARKER_TTL_MS,
        mode: 'NX',
      });
      expect(SMTP_CERT_ALERT_MARKER_TTL_MS).toBeGreaterThan(90 * DAY_MS);
    });
  });

  describe('empreinte différente ⇒ paliers réarmés', () => {
    it('réalerte au même palier après un renouvellement du certificat', async () => {
      // Certificat A, palier 7 franchi : une alerte, puis le silence.
      clock = daysBeforeExpiry(7);
      await bootstrap();
      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(1);

      // Le porteur renouvelle. Nouveau certificat, nouvelle empreinte —
      // et rien d'autre ne change : ni le palier, ni l'échéance simulée.
      // C'est l'empreinte dans la clé, et elle seule, qui réarme le compteur.
      inspect.mockReturnValue(snapshot(FINGERPRINT_B));
      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(2);
      expect(lastPayload().subject).toBe(
        'Certificat SMTP : expire dans 7 jours',
      );

      // Deux clés distinctes coexistent : aucun code de nettoyage n'est
      // nécessaire, celle du certificat retiré expirera d'elle-même.
      expect(redis.keys).toEqual([
        `smtp-cert-alert:${FINGERPRINT_A}:j7`,
        `smtp-cert-alert:${FINGERPRINT_B}:j7`,
      ]);

      // Et le nouveau certificat retombe aussitôt dans le silence.
      await scheduler.tick();
      expect(sendSystem).toHaveBeenCalledTimes(2);
    });
  });

  describe('certificat expiré', () => {
    beforeEach(() => {
      clock = new Date(EXPIRES_AT.getTime() + 2 * DAY_MS);
    });

    it('émet une alerte spécifique', async () => {
      await bootstrap();

      expect(lastPayload().subject).toBe(
        'Certificat SMTP : EXPIRÉ depuis 2 jours',
      );
      expect(lastPayload().text).toContain('EXPIRÉ');
    });

    it('n’en émet qu’une, sur sa propre clé', async () => {
      await bootstrap();
      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(1);
      expect(redis.keys).toEqual([`smtp-cert-alert:${FINGERPRINT_A}:expire`]);
    });

    it('traite l’instant exact de l’échéance comme une expiration', async () => {
      clock = new Date(EXPIRES_AT);

      await bootstrap();

      expect(lastPayload().subject).toBe(
        "Certificat SMTP : EXPIRÉ aujourd'hui",
      );
    });
  });

  describe('fichier absent, illisible ou non analysable', () => {
    beforeEach(() => {
      inspect.mockImplementation(() => {
        throw new Error(
          `certificat introuvable, illisible ou non analysable à « ${CERT_PATH} » — ENOENT`,
        );
      });
    });

    it('émet une alerte spécifique qui nomme le fichier et l’erreur', async () => {
      await bootstrap();

      expect(lastPayload().subject).toBe(
        'Certificat SMTP : fichier introuvable ou illisible',
      );
      expect(lastPayload().text).toContain(CERT_PATH);
      expect(lastPayload().text).toContain('ENOENT');
    });

    it('n’en émet qu’une, sur la clé sentinelle « sans-certificat »', async () => {
      await bootstrap();
      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(1);
      expect(redis.keys).toEqual(['smtp-cert-alert:sans-certificat:illisible']);
    });

    it('réalerte normalement quand un certificat lisible revient', async () => {
      await bootstrap();
      expect(sendSystem).toHaveBeenCalledTimes(1);

      inspect.mockReturnValue(snapshot());
      clock = daysBeforeExpiry(7);
      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(2);
      expect(lastPayload().subject).toBe(
        'Certificat SMTP : expire dans 7 jours',
      );
    });
  });

  describe('destinataire', () => {
    it('préfère ALERTS_EMAIL_TO à ADMIN_EMAIL', async () => {
      env.ADMIN_EMAIL = ADMIN;

      await bootstrap();

      expect(lastPayload().to).toBe(RECIPIENT);
    });

    it('retombe sur ADMIN_EMAIL', async () => {
      delete env.ALERTS_EMAIL_TO;
      env.ADMIN_EMAIL = ADMIN;

      await bootstrap();

      expect(lastPayload().to).toBe(ADMIN);
    });

    it('normalise la casse de la variable pour retrouver le compte', async () => {
      env.ALERTS_EMAIL_TO = '  Alertes@Zendou.GN ';

      await bootstrap();

      expect(findUnique).toHaveBeenCalledWith({
        where: { email: RECIPIENT },
        select: { id: true },
      });
    });

    it('sans destinataire : avertit au démarrage, n’envoie rien, ne lève rien', async () => {
      delete env.ALERTS_EMAIL_TO;

      await expect(bootstrap()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE);
      expect(sendSystem).not.toHaveBeenCalled();
      // Rien n'est réservé : le jour où un destinataire est configuré,
      // l'alerte partira au premier contrôle.
      expect(redis.setCalls).toEqual([]);
    });

    it('sans destinataire : journalise tout de même l’alerte', async () => {
      delete env.ALERTS_EMAIL_TO;

      await bootstrap();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('expire dans 7 jours'),
      );
    });

    it('sans destinataire : surveille quand même, sans jamais lever', async () => {
      delete env.ALERTS_EMAIL_TO;

      await bootstrap();

      await expect(scheduler.tick()).resolves.toBeUndefined();
    });
  });

  describe('échec d’envoi', () => {
    it('avale et journalise un rejet de sendSystem', async () => {
      sendSystem.mockRejectedValue(new Error('SES injoignable'));

      await expect(bootstrap()).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        `Alerte certificat SMTP non expédiée à ${RECIPIENT}`,
        expect.any(String),
      );
    });

    it('relâche le marqueur pour réessayer au contrôle suivant', async () => {
      sendSystem.mockRejectedValueOnce(new Error('SES injoignable'));

      await bootstrap();
      expect(redis.delCalls).toEqual([`smtp-cert-alert:${FINGERPRINT_A}:j7`]);
      expect(redis.keys).toEqual([]);

      await scheduler.tick();

      expect(sendSystem).toHaveBeenCalledTimes(2);
      expect(redis.keys).toEqual([`smtp-cert-alert:${FINGERPRINT_A}:j7`]);
    });

    it('traite une adresse en liste de suppression comme un échec, sans lever', async () => {
      sendSystem.mockResolvedValue({ status: 'suppressed' });

      await expect(bootstrap()).resolves.toBeUndefined();

      expect(redis.keys).toEqual([]);
      expect(error).toHaveBeenCalledWith(
        `Alerte certificat SMTP non expédiée à ${RECIPIENT}`,
        expect.any(String),
      );
    });

    it('avale un destinataire inconnu de Zendou', async () => {
      findUnique.mockResolvedValue(null);

      await expect(bootstrap()).resolves.toBeUndefined();

      expect(sendSystem).not.toHaveBeenCalled();
      expect(redis.keys).toEqual([]);
    });

    it('avale une base de données injoignable', async () => {
      findUnique.mockRejectedValue(new Error('P1001'));

      await expect(bootstrap()).resolves.toBeUndefined();
      expect(scheduler.started).toHaveLength(1);
    });

    it('alerte quand même quand Redis est injoignable', async () => {
      redis.failing = true;

      await expect(bootstrap()).resolves.toBeUndefined();

      // Un doublon d'email coûte moins cher qu'une alerte perdue.
      expect(sendSystem).toHaveBeenCalledTimes(1);
    });

    it('n’interrompt jamais un contrôle sur une erreur inattendue', async () => {
      inspect.mockImplementation(() => {
        throw new Error('boum');
      });
      sendSystem.mockImplementation(() => {
        throw new Error('boum aussi');
      });

      await expect(bootstrap()).resolves.toBeUndefined();
      await expect(scheduler.tick()).resolves.toBeUndefined();
    });
  });

  describe('contenu de l’email', () => {
    beforeEach(() => {
      clock = daysBeforeExpiry(7);
    });

    it('porte la date d’expiration et les jours restants', async () => {
      await bootstrap();

      const { text, html } = lastPayload();

      expect(text).toContain('12 novembre 2026 à 08:00 UTC');
      expect(text).toContain('Jours restants : 7');
      expect(html).toContain('12 novembre 2026 à 08:00 UTC');
      expect(html).toContain('Jours restants : 7');
    });

    it('nomme le domaine du certificat', async () => {
      await bootstrap();

      expect(lastPayload().text).toContain('Domaine : smtp.zendou.gn');
    });

    it('porte les commandes exactes de renouvellement', async () => {
      await bootstrap();

      const { text } = lastPayload();

      expect(text).toContain('certbot certonly');
      expect(text).toContain('--dns-cloudflare');
      expect(text).toContain('-d smtp.zendou.gn');
      expect(text).toContain(
        'cat /etc/letsencrypt/live/smtp.zendou.gn/fullchain.pem',
      );
      expect(text).toContain('File Mounts');
      expect(text).toContain('SMTP_TLS_CERT_PATH');
      expect(text).toContain('Redéployer');
    });

    it('donne un repère à compléter pour les identifiants, et le périmètre du jeton', async () => {
      await bootstrap();

      const { text } = lastPayload();

      // Un chemin absolu vraisemblable ferait croire que le fichier existe
      // déjà : son emplacement dépend du poste depuis lequel on renouvelle.
      expect(text).toContain(
        '--dns-cloudflare-credentials <chemin-vers>/credentials.ini',
      );
      expect(text).toContain('« Zone → DNS → Edit » sur zendou.app');
    });

    it('ne présuppose aucun accès au serveur — le porteur n’a qu’un compte Dokploy', async () => {
      await bootstrap();

      const { text, html } = lastPayload();

      // Le porteur n'a ni SSH ni root sur la machine du relais : elle est
      // administrée par un tiers. Une marche à suivre qui commencerait par
      // « connectez-vous au VPS » le bloquerait au moment précis où il doit
      // agir vite — pire qu'une alerte sans instructions.
      for (const body of [text, html]) {
        expect(body).not.toContain('VPS');
        expect(body).not.toContain('/root/');
      }

      // Et l'information qui débloque, dite explicitement : le défi DNS-01
      // prouve la maîtrise de la zone, pas celle du serveur.
      expect(text).toContain("Aucun accès au serveur n'est nécessaire");
      expect(text).toContain("ne s'adresse qu'à l'API Cloudflare");
    });

    it('fournit systématiquement les deux variantes, texte et HTML', async () => {
      await bootstrap();

      const { html, text } = lastPayload();

      expect(text).toContain('Zendou, surveillance du relais SMTP');
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('échappe le message d’erreur inséré dans le HTML', async () => {
      inspect.mockImplementation(() => {
        throw new Error('<script>alert(1)</script>');
      });

      await bootstrap();

      expect(lastPayload().html).not.toContain('<script>');
      expect(lastPayload().html).toContain('&lt;script&gt;');
    });
  });

  describe('arrêt', () => {
    it('ferme le planificateur et la connexion Redis', async () => {
      await bootstrap();
      await service.onModuleDestroy();

      expect(scheduler.stopped).toBe(1);
      expect(redis.disconnected).toBe(true);
    });

    it('ne ferme pas un planificateur jamais démarré', async () => {
      env.SMTP_RELAY_ENABLED = false;

      await bootstrap();
      await service.onModuleDestroy();

      expect(scheduler.stopped).toBe(0);
      expect(redis.disconnected).toBe(true);
    });
  });
});
