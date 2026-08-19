import { createServer, Server } from 'net';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { SmtpAuthService } from './smtp-auth.service';
import { SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE } from './smtp-relay.constants';
import { SmtpServerService } from './smtp-server.service';

/**
 * Comportements de démarrage du relais : inertie par défaut, refus de démarrer
 * sans certificat en production, échec bruyant sur port occupé, arrêt
 * gracieux. Tout ce qui touche à la conversation SMTP elle-même est vérifié
 * par `smtp-server.integration.spec.ts`, avec un vrai client.
 */

jest.setTimeout(30_000);

const HOST = '127.0.0.1';

async function buildService(
  config: Record<string, unknown>,
): Promise<{ moduleRef: TestingModule; service: SmtpServerService }> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SmtpServerService,
      {
        provide: ConfigService,
        useValue: { get: (key: string) => config[key] },
      },
      {
        provide: SmtpAuthService,
        useValue: { authenticate: jest.fn() },
      },
      {
        provide: PrismaService,
        useValue: { smtpCredential: { findUnique: jest.fn() } },
      },
    ],
  }).compile();

  return { moduleRef, service: moduleRef.get(SmtpServerService) };
}

describe('SmtpServerService — module inerte sans SMTP_RELAY_ENABLED', () => {
  /**
   * C'est l'état par défaut de **tous** les environnements actuels, production
   * comprise : au prochain déploiement, ce module sera présent dans
   * `AppModule` sans que rien ne change pour l'API. La preuve doit donc porter
   * sur l'absence d'effet, pas seulement sur l'absence d'écoute.
   */
  it.each([
    ['variable absente', {}],
    ['variable à false', { SMTP_RELAY_ENABLED: false }],
  ])('n’écoute rien quand %s', async (_label, relayConfig) => {
    const reads: string[] = [];
    const config: Record<string, unknown> = {
      NODE_ENV: 'test',
      SMTP_PORTS_STARTTLS: [0],
      SMTP_PORTS_TLS: [0],
      SMTP_BIND_ADDRESS: HOST,
      ...relayConfig,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SmtpServerService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              reads.push(key);
              return config[key];
            },
          },
        },
        { provide: SmtpAuthService, useValue: { authenticate: jest.fn() } },
        {
          provide: PrismaService,
          useValue: { smtpCredential: { findUnique: jest.fn() } },
        },
      ],
    }).compile();

    const service = moduleRef.get(SmtpServerService);
    await service.onModuleInit();

    expect(service.listeningPorts).toEqual([]);
    // Rien d'autre n'est même consulté : pas de port lu, pas de chemin de
    // certificat, donc aucune chance d'ouvrir un socket ou de lire un fichier.
    expect(reads).toEqual(['SMTP_RELAY_ENABLED']);

    await service.onModuleDestroy();
    await moduleRef.close();
  });
});

describe('SmtpServerService — certificat obligatoire en production (§1.4)', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('refuse de démarrer sans chemin de certificat', async () => {
    const { moduleRef, service } = await buildService({
      NODE_ENV: 'production',
      SMTP_RELAY_ENABLED: true,
      SMTP_PORTS_STARTTLS: [0],
      SMTP_PORTS_TLS: [],
      SMTP_BIND_ADDRESS: HOST,
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
    );
    expect(service.listeningPorts).toEqual([]);

    await moduleRef.close();
  });

  it('refuse de démarrer si les fichiers sont introuvables', async () => {
    const { moduleRef, service } = await buildService({
      NODE_ENV: 'production',
      SMTP_RELAY_ENABLED: true,
      SMTP_PORTS_STARTTLS: [0],
      SMTP_PORTS_TLS: [],
      SMTP_BIND_ADDRESS: HOST,
      SMTP_TLS_CERT_PATH: '/inexistant/fullchain.pem',
      SMTP_TLS_KEY_PATH: '/inexistant/privkey.pem',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      /Certificat TLS du relais SMTP illisible/,
    );
    expect(service.listeningPorts).toEqual([]);

    await moduleRef.close();
  });
});

describe('SmtpServerService — écoute, échec bruyant et arrêt gracieux', () => {
  /**
   * Contrepartie n°2 du §1.1 : un port déjà pris doit faire échouer le
   * démarrage proprement — surtout pas devenir une exception non capturée qui
   * emporterait l'API hébergée dans le même processus.
   */
  it('échoue au démarrage quand le port est déjà occupé', async () => {
    const squatter: Server = createServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      squatter.listen(0, HOST, () => {
        const address = squatter.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    const { moduleRef, service } = await buildService({
      NODE_ENV: 'test',
      SMTP_RELAY_ENABLED: true,
      SMTP_PORTS_STARTTLS: [occupiedPort],
      SMTP_PORTS_TLS: [],
      SMTP_BIND_ADDRESS: HOST,
    });

    const logSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.onModuleInit()).rejects.toThrow(
      new RegExp(`Écoute SMTP impossible sur ${HOST}:${occupiedPort}`),
    );
    expect(service.listeningPorts).toEqual([]);

    logSpy.mockRestore();
    await moduleRef.close();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });

  it('démarre trois instances puis libère tous les ports à l’arrêt', async () => {
    const { moduleRef, service } = await buildService({
      NODE_ENV: 'test',
      SMTP_RELAY_ENABLED: true,
      // Trois instances partageant un seul objet de handlers (§1.2), ports
      // éphémères pour ne dépendre d'aucun privilège ni d'aucune convention.
      SMTP_PORTS_STARTTLS: [0, 0],
      SMTP_PORTS_TLS: [0],
      SMTP_BIND_ADDRESS: HOST,
      SMTP_CLOSE_TIMEOUT_MS: 1_000,
    });

    await service.onModuleInit();

    const ports = [...service.listeningPorts];
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);

    await service.onModuleDestroy();
    expect(service.listeningPorts).toEqual([]);

    // Les ports sont réellement rendus : on peut les reprendre.
    for (const port of ports) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, HOST, () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }

    await moduleRef.close();
  });
});
