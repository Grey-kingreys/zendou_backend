import { FSWatcher, watch } from 'fs';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SMTPServer,
  type SMTPServerAuthentication,
  type SMTPServerAuthenticationResponse,
  type SMTPServerDataStream,
  type SMTPServerOptions,
  type SMTPServerSession,
} from 'smtp-server';
import { SmtpAuthService } from './smtp-auth.service';
import { SmtpPipelineService } from './smtp-pipeline.service';
import {
  SMTP_IP_LIMITS_DISABLED_MESSAGE,
  SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE,
  SMTP_TLS_RELOAD_DEBOUNCE_MS,
} from './smtp-relay.constants';
import {
  SMTP_REPLY_AUTH_INVALID_CREDENTIALS,
  SMTP_REPLY_AUTH_REQUIRES_TLS,
  SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH,
  SMTP_REPLY_UNKNOWN_SERVER_ERROR,
} from './smtp-reply';
import { isSmtpReplyError, smtpReplyToError } from './smtp-reply.adapter';
import { smtpSessionUser, type SmtpSessionUser } from './smtp-session';
import { SmtpThrottleService } from './smtp-throttle.service';
import { readSmtpTlsMaterial, type SmtpTlsMaterial } from './smtp-tls';

/** Sous-ensemble de `SMTPServerOptions` que toutes les instances partagent. */
type SmtpRelayHandlers = Required<
  Pick<
    SMTPServerOptions,
    'onConnect' | 'onAuth' | 'onMailFrom' | 'onRcptTo' | 'onData' | 'onClose'
  >
>;

/**
 * Relais SMTP entrant de Zendou : écoute, TLS, session, authentification
 * (B6/S5).
 *
 * Le module tourne **dans le processus NestJS** (A1). Ce choix n'est tenable
 * qu'accompagné des trois contreparties du §1.1, qui sont donc les invariants
 * de ce fichier :
 *
 * 1. **Aucune exception ne franchit la frontière d'un callback
 *    `smtp-server`.** Les six points d'accroche passent par {@link run}, qui
 *    transforme toute erreur inattendue en `451 4.3.0` journalisé. Un bug dans
 *    le relais coûte un message, jamais l'API.
 * 2. **`server.on('error')` est traité.** `smtp-server` réémet sur le serveur
 *    aussi bien les erreurs d'écoute que celles des connexions
 *    (`lib/smtp-server.js:155,339,396`) : sans écouteur, un simple `ECONNRESET`
 *    client deviendrait une exception non capturée qui tuerait le processus.
 *    Un `EADDRINUSE` au démarrage échoue proprement et bruyamment.
 * 3. **Aucune dépendance à `main.ts`.** Tout vit ici ; basculer plus tard vers
 *    un processus dédié se réduira à ajouter un fichier de bootstrap.
 *
 * Et, avant tout cela : **sans `SMTP_RELAY_ENABLED`, rien ne démarre.** C'est
 * l'état par défaut de tous les environnements actuels, production comprise —
 * aucun port ouvert, aucun fichier lu, aucun observateur posé.
 */
@Injectable()
export class SmtpServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmtpServerService.name);
  private readonly servers: SMTPServer[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly ports: number[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly smtpAuthService: SmtpAuthService,
    private readonly smtpThrottleService: SmtpThrottleService,
    private readonly smtpPipelineService: SmtpPipelineService,
  ) {}

  /**
   * Ports réellement liés, dans l'ordre de démarrage. Vide quand le relais est
   * désactivé — c'est la preuve observable qu'un module inerte n'écoute nulle
   * part, et la donnée dont `/health` aura besoin (S10, A16).
   */
  get listeningPorts(): readonly number[] {
    return this.ports;
  }

  /**
   * Vrai si au moins une instance a démarré et que **toutes** celles
   * démarrées sont encore effectivement en écoute (`net.Server#listening`).
   *
   * Diffère de `listeningPorts.length > 0` : ce tableau n'est mis à jour qu'au
   * démarrage et à l'arrêt gracieux (`shutdown`), il resterait donc « plein »
   * si une instance cessait d'écouter d'elle-même entre les deux (crash du
   * socket sous-jacent, fermeture externe). `/health` (S10, A16) interroge
   * cette propriété-ci pour distinguer un relais réellement mort d'un relais
   * simplement désactivé — c'est à l'appelant de savoir lequel des deux cas
   * il observe (`SMTP_RELAY_ENABLED`), cette propriété ne fait que rapporter
   * l'état de socket brut.
   */
  get isListening(): boolean {
    return (
      this.servers.length > 0 &&
      this.servers.every((server) => server.server.listening)
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.configService.get<boolean>('SMTP_RELAY_ENABLED')) {
      this.logger.log(
        'Relais SMTP désactivé (SMTP_RELAY_ENABLED absent ou false) — aucun port écouté',
      );
      return;
    }

    try {
      await this.start();
    } catch (error: unknown) {
      // Démarrage partiel : refermer ce qui a déjà été lié avant de propager,
      // sinon un redémarrage automatique retomberait sur ses propres ports.
      await this.shutdown();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Démarrage
  // ─────────────────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    const isProduction = nodeEnv === 'production';

    /**
     * `allowInsecureAuth` est **réservé aux tests** (§3.3). C'est lui qui rend
     * la conversation entière vérifiable en Jest sans certificat ; partout
     * ailleurs, `smtp-server` refuse l'AUTH avant STARTTLS et notre propre
     * contrôle (voir {@link createHandlers}) le double.
     */
    const allowInsecureAuth = nodeEnv === 'test';
    const tls = this.loadTlsMaterial(isProduction);
    const handlers = this.createHandlers(!allowInsecureAuth);

    const baseOptions: SMTPServerOptions = {
      ...handlers,
      ...(tls ? { key: tls.key, cert: tls.cert } : {}),

      authMethods: ['PLAIN', 'LOGIN'],

      // Jamais `authOptional` (§5) : un relais qui accepte du courrier sans
      // authentification est un open relay. C'est aussi ce réglage qui fait
      // répondre `530` au `MAIL FROM` d'une session anonyme.
      authOptional: false,
      allowInsecureAuth,

      // Voir `smtp-reply.adapter.ts` : la table de statuts étendus de
      // `smtp-server` contredit le §4.4 sur la plupart des lignes, et
      // l'application ne peut pas l'influencer. On la neutralise ici et on
      // écrit nous-mêmes le statut en tête du texte. Explicite malgré le
      // défaut identique de la bibliothèque : c'est un défaut, pas un contrat.
      hideENHANCEDSTATUSCODES: true,

      // Une résolution DNS inverse par connexion, c'est une latence et un
      // levier de déni de service offerts à l'attaquant ; `clientHostname` ne
      // sert à aucune décision du relais.
      disableReverseLookup: true,

      // `useXClient` / `useXForward` restent désactivés : ils laisseraient un
      // client réécrire `session.remoteAddress`, sur lequel S9 fonde toutes
      // ses limites par IP.

      // §4.5 — le plafond de taille d'un message, annoncé et appliqué par la
      // même option : `smtp-server` publie `SIZE <octets>` dans l'EHLO
      // (RFC 1870), refuse un `SIZE=` annoncé trop grand dès le `MAIL FROM`,
      // et lève `stream.sizeExceeded` si le client ment. Le client sait donc
      // **avant** d'envoyer, et le relais ne dépend pas de sa parole.
      size: this.smtpPipelineService.maxMessageBytes,

      maxClients: this.configService.get<number>('SMTP_MAX_CLIENTS'),
      socketTimeout: this.configService.get<number>('SMTP_SOCKET_TIMEOUT_MS'),
      closeTimeout: this.configService.get<number>('SMTP_CLOSE_TIMEOUT_MS'),

      // Journalisation par nos soins (Logger Nest), pas par le bunyan interne.
      logger: false,
    };

    const host =
      this.configService.get<string>('SMTP_BIND_ADDRESS') ?? '0.0.0.0';
    const starttlsPorts =
      this.configService.get<number[]>('SMTP_PORTS_STARTTLS') ?? [];
    const tlsPorts = this.configService.get<number[]>('SMTP_PORTS_TLS') ?? [];

    for (const port of starttlsPorts) {
      await this.startInstance({ ...baseOptions, secure: false }, port, host);
    }

    for (const port of tlsPorts) {
      await this.startInstance({ ...baseOptions, secure: true }, port, host);
    }

    if (tls) {
      this.watchTlsFiles();
    }

    this.logger.log(
      `Relais SMTP à l'écoute sur ${host} — ports ${this.ports.join(', ')}` +
        (tls ? ' (certificat fourni)' : ' (aucun certificat fourni)'),
    );

    // §5 / §1.3 (S9) — désactiver les limites par IP est un choix légitime
    // quand l'IP source n'arrive pas intacte, mais il retire une protection :
    // il doit se voir dans les journaux de démarrage, une fois, au même
    // endroit que les ports. Un exploitant qui lit « à l'écoute sur … » doit
    // lire aussi ce qui n'est pas gardé.
    if (!this.smtpThrottleService.ipLimitsEnabled) {
      this.logger.warn(SMTP_IP_LIMITS_DISABLED_MESSAGE);
    }
  }

  private async startInstance(
    options: SMTPServerOptions,
    port: number,
    host: string,
  ): Promise<void> {
    const server = new SMTPServer(options);

    // Contrepartie n°2 : l'écouteur permanent est posé **avant** l'écoute, et
    // n'est jamais retiré. `smtp-server` réémet ici les erreurs de socket des
    // connexions ; sans lui, la moindre coupure client devient une exception
    // non capturée qui emporte le processus, API comprise.
    server.on('error', (error: Error) => {
      this.logger.warn(
        `Erreur du serveur SMTP (port ${port}) : ${error.message}`,
        error.stack,
      );
    });

    this.servers.push(server);
    this.ports.push(await listen(server, port, host));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TLS
  // ─────────────────────────────────────────────────────────────────────────

  private loadTlsMaterial(isProduction: boolean): SmtpTlsMaterial | null {
    const paths = this.tlsPaths();

    if (!paths) {
      if (isProduction) {
        // Normalement inatteignable : le `refine` d'`env.schema.ts` rejette
        // déjà cette configuration. Gardé comme assertion de dernier recours,
        // parce que la règle « jamais de soumission en clair en production »
        // (A19) ne doit dépendre d'aucun appelant.
        throw new Error(SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE);
      }

      // Hors production, `smtp-server` sert son certificat auto-signé intégré :
      // STARTTLS reste disponible en développement, et les tests n'ont besoin
      // d'aucun fichier.
      this.logger.warn(
        'Aucun certificat TLS configuré (SMTP_TLS_CERT_PATH / SMTP_TLS_KEY_PATH) — certificat auto-signé de smtp-server utilisé, acceptable hors production uniquement',
      );
      return null;
    }

    // Les chemins sont renseignés : un fichier absent ou illisible est une
    // erreur de configuration dans tous les environnements, et doit se voir.
    return readSmtpTlsMaterial(paths);
  }

  private tlsPaths(): { certPath: string; keyPath: string } | null {
    const certPath = this.configService.get<string>('SMTP_TLS_CERT_PATH');
    const keyPath = this.configService.get<string>('SMTP_TLS_KEY_PATH');

    return certPath && keyPath ? { certPath, keyPath } : null;
  }

  /**
   * Surveille les deux fichiers pour recharger le contexte TLS au
   * renouvellement, **sans redémarrage** (§1.4). Sans cela le certificat
   * expirerait silencieusement au bout de 90 jours et tous les clients SMTP
   * tomberaient d'un coup.
   */
  private watchTlsFiles(): void {
    const paths = this.tlsPaths();

    if (!paths) {
      return;
    }

    this.watchTlsFile(paths.certPath);
    this.watchTlsFile(paths.keyPath);
  }

  private watchTlsFile(path: string): void {
    if (this.watchers.has(path)) {
      return;
    }

    try {
      const watcher = watch(path, (eventType) => {
        this.scheduleTlsReload();

        // `certbot` renouvelle par remplacement atomique : le lien est refait,
        // l'inode change, et l'observateur posé sur l'ancien devient sourd.
        // On le repose après l'apaisement, sur le chemin — pas sur l'inode.
        if (eventType === 'rename') {
          this.watchers.get(path)?.close();
          this.watchers.delete(path);
          setTimeout(
            () => this.watchTlsFile(path),
            SMTP_TLS_RELOAD_DEBOUNCE_MS,
          ).unref();
        }
      });

      watcher.on('error', (error: Error) => {
        this.logger.warn(
          `Surveillance du fichier TLS « ${path} » interrompue : ${error.message}`,
        );
      });

      this.watchers.set(path, watcher);
    } catch (error: unknown) {
      // Ne pas surveiller est une dégradation (le certificat expirera sans
      // rechargement), pas une raison de refuser de servir du courrier.
      this.logger.warn(
        `Impossible de surveiller le fichier TLS « ${path} » : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private scheduleTlsReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    // `certbot` réécrit la clé **et** le certificat : relire dès le premier
    // événement donnerait un couple incohérent au milieu du renouvellement.
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reloadTlsMaterial();
    }, SMTP_TLS_RELOAD_DEBOUNCE_MS);
    this.reloadTimer.unref();
  }

  /**
   * Relit les fichiers et pousse le nouveau contexte dans chaque instance.
   * **Ne lève jamais** : un renouvellement raté doit laisser l'ancien
   * certificat — encore valide — en service, pas interrompre le relais.
   */
  private reloadTlsMaterial(): void {
    const paths = this.tlsPaths();

    if (!paths) {
      return;
    }

    let material: SmtpTlsMaterial;

    try {
      material = readSmtpTlsMaterial(paths);
    } catch (error: unknown) {
      this.logger.error(
        `Rechargement du certificat TLS impossible — l'ancien contexte reste en service : ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const server of this.servers) {
      try {
        server.updateSecureContext({ key: material.key, cert: material.cert });
      } catch (error: unknown) {
        this.logger.error(
          `Mise à jour du contexte TLS refusée par une instance : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log('Certificat TLS du relais SMTP rechargé');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Points d'accroche `smtp-server`
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Construit **un seul** objet de handlers, partagé par les trois instances
   * (§1.2) : le port par lequel un client arrive ne change aucune règle, et
   * dupliquer les handlers par instance serait la meilleure façon de faire
   * diverger 587 et 465 sans que personne ne le remarque.
   */
  private createHandlers(requireTlsForAuth: boolean): SmtpRelayHandlers {
    return {
      onConnect: (session, callback) => {
        this.run('CONNECT', session, callback, async () => {
          this.logger.debug?.(
            `Connexion SMTP ${session.id} depuis ${session.remoteAddress}`,
          );

          // S9 : ouvre les compteurs de la connexion et applique le plafond
          // par IP. Un dépassement lève `421 4.7.0`, que `smtp-server` envoie
          // **à la place de la bannière 220** avant de fermer le socket.
          await this.smtpThrottleService.registerConnection(session);
        });
      },

      onAuth: (
        auth: SMTPServerAuthentication,
        session: SMTPServerSession,
        callback,
      ) => {
        this.run<SMTPServerAuthenticationResponse>(
          'AUTH',
          session,
          callback,
          async () => {
            // Doublure de la garde native de `smtp-server`
            // (`lib/smtp-connection.js:1615`, qui répond déjà `538` avant
            // même d'appeler ce handler). Elle couvre la configuration où
            // STARTTLS n'est pas annoncé sans que le canal soit chiffré pour
            // autant — cas où la garde native ne se déclenche pas, et où
            // laisser passer un secret en clair serait la pire des issues.
            if (requireTlsForAuth && !session.secure) {
              throw smtpReplyToError(SMTP_REPLY_AUTH_REQUIRES_TLS);
            }

            let user: SmtpSessionUser;

            try {
              user = await this.smtpAuthService.authenticate(
                auth.username,
                auth.password,
                session.remoteAddress,
              );
            } catch (error: unknown) {
              // S9 : ne comptent que les **vrais** échecs d'identifiants —
              // ceux qui portent la constante `535` de S5. Une panne de base
              // (`451`) est notre faute, pas une tentative de bourrinage : la
              // compter fermerait la connexion d'un client irréprochable
              // pendant un incident, et pourrirait l'alerte de stuffing.
              if (isAuthCredentialFailure(error)) {
                // Peut lever `421` + fermeture, qui remplace alors le `535` :
                // c'est la ligne « Trop d'échecs AUTH sur la connexion » du
                // §4.4. Le mot de passe présenté n'est pas transmis — il ne
                // peut donc pas être journalisé (§5).
                await this.smtpThrottleService.recordAuthFailure(
                  session,
                  auth.username,
                );
              }

              throw error;
            }

            this.logger.log(
              `Session SMTP ${session.id} authentifiée : identifiant ${user.credentialId} (${user.username}) depuis ${session.remoteAddress}`,
            );

            return { user };
          },
        );
      },

      // Les trois étapes suivantes sont déléguées à `SmtpPipelineService`
      // (S7) : ce fichier tient l'écoute, le TLS et la session, pas les règles
      // d'envoi. La seule chose qu'il fait ici de son propre chef est
      // l'assertion « pas d'open relay », qui doit précéder tout le reste.
      onMailFrom: (address, session, callback) => {
        this.run('MAIL FROM', session, callback, async () => {
          const user = this.requireAuthenticatedSession(session);

          // §4.8 — invariant à ne pas perdre : ces contrôles ne peuvent que
          // **refuser**, jamais autoriser. La décision qui fait foi tombe en
          // fin de DATA, dans `EmailsService.accept()`.
          await this.smtpPipelineService.mailFrom(address, session, user);
        });
      },

      onRcptTo: (address, session, callback) => {
        this.run('RCPT TO', session, callback, async () => {
          const user = this.requireAuthenticatedSession(session);

          await this.smtpPipelineService.rcptTo(address, session, user);
        });
      },

      onData: (
        stream: SMTPServerDataStream,
        session: SMTPServerSession,
        callback,
      ) => {
        this.run<string>('DATA', session, callback, async () => {
          const user = this.requireAuthenticatedSession(session);

          // Le pipeline consomme le flux jusqu'au bout quoi qu'il arrive —
          // y compris quand il refuse : `smtp-server` attend le point final
          // pour reprendre la conversation, et un flux laissé en suspens
          // gèle la connexion jusqu'au `socketTimeout`.
          //
          // La valeur rendue est le texte du `250` (§4.7, réponse agrégée) ;
          // `smtp-server` y appose le code. Ne rien rendre serait pire qu'un
          // refus : son texte par défaut ferait croire au client que le
          // message est parti alors qu'aucune ligne n'existerait.
          return this.smtpPipelineService.data(stream, session, user);
        });
      },

      onClose: (session) => {
        this.logger.debug?.(`Session SMTP ${session.id} fermée`);

        // S9 : libère les compteurs de la connexion. `smtp-server` émet
        // `onClose` pour **toute** session, y compris celle qu'on vient de
        // refuser en `421` à l'ouverture — sans quoi la table des compteurs
        // grandirait au rythme des tentatives d'abus.
        this.smtpThrottleService.releaseConnection(session);
      },
    };
  }

  /**
   * Assertion explicite de `session.user` exigée au §5 (« pas d'open relay »),
   * **en plus** du refus natif de `smtp-server`, qui répond déjà `530` au
   * `MAIL FROM` d'une session anonyme sans jamais appeler nos handlers. Deux
   * verrous plutôt qu'un : celui de la bibliothèque dépend de son option
   * `authOptional`, celui-ci ne dépend que de nous.
   *
   * Rend l'utilisateur authentifié plutôt que rien : c'est ce qui permet au
   * pipeline (S7) de le recevoir en argument au lieu de le relire de la
   * session. Il n'existe donc aucun chemin par lequel une étape du pipeline
   * s'exécuterait sans utilisateur — la garantie « pas d'open relay » est
   * portée par le type, pas par la discipline de l'appelant.
   */
  private requireAuthenticatedSession(
    session: SMTPServerSession,
  ): SmtpSessionUser {
    const user = smtpSessionUser(session);

    if (!user) {
      throw smtpReplyToError(SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH);
    }

    return user;
  }

  /**
   * Enveloppe anti-exception, contrepartie n°1 du §1.1 : **aucune exception ne
   * franchit la frontière d'un callback `smtp-server`**.
   *
   * - un refus délibéré (erreur marquée par `smtpReplyToError`) est transmis
   *   tel quel : c'est une réponse du §4.4, elle a déjà son code et son texte ;
   * - toute autre erreur — y compris levée de façon synchrone, d'où le
   *   `Promise.resolve().then(...)` — est journalisée avec sa pile puis rendue
   *   au client en `451 4.3.0`, jamais propagée au processus ;
   * - le callback est protégé contre un double appel, qui désynchroniserait la
   *   conversation SMTP.
   */
  private run<TResult>(
    step: string,
    session: SMTPServerSession,
    callback: (error?: Error | null, result?: TResult) => void,
    handler: () => Promise<TResult | void> | TResult | void,
  ): void {
    let settled = false;

    const settle = (error: Error | null, result?: TResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback(error, result);
    };

    Promise.resolve()
      .then(handler)
      .then(
        (result) => settle(null, (result ?? undefined) as TResult | undefined),
        (error: unknown) => {
          if (isSmtpReplyError(error)) {
            settle(error);
            return;
          }

          this.logger.error(
            `Exception inattendue pendant ${step} (session ${session.id}, ${session.remoteAddress}) — réponse ${SMTP_REPLY_UNKNOWN_SERVER_ERROR.code} rendue au client`,
            error instanceof Error ? error.stack : String(error),
          );

          settle(smtpReplyToError(SMTP_REPLY_UNKNOWN_SERVER_ERROR));
        },
      );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Arrêt
  // ─────────────────────────────────────────────────────────────────────────

  private async shutdown(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    const servers = this.servers.splice(0, this.servers.length);
    this.ports.length = 0;

    await Promise.all(servers.map((server) => close(server)));

    if (servers.length > 0) {
      this.logger.log('Relais SMTP arrêté');
    }
  }
}

/**
 * Lie une instance et rend le port réellement obtenu — qui diffère de celui
 * demandé quand on écoute sur le port éphémère `0`, ce dont les tests
 * d'intégration en processus dépendent.
 *
 * L'écouteur d'erreur temporaire ne remplace pas le permanent posé par
 * `startInstance` : il ne sert qu'à transformer un échec d'écoute
 * (`EADDRINUSE`, `EACCES` sur un port privilégié) en rejet de promesse, donc
 * en échec de démarrage propre et bruyant plutôt qu'en exception non capturée.
 */
function listen(
  server: SMTPServer,
  port: number,
  host: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;

    const onListenError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        new Error(
          `Écoute SMTP impossible sur ${host}:${port} — ${error.message}`,
        ),
      );
    };

    server.once('error', onListenError);

    const netServer = server.listen(port, host, () => {
      if (settled) {
        return;
      }
      settled = true;
      server.removeListener('error', onListenError);

      const address = netServer.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : port,
      );
    });
  });
}

/** Arrêt gracieux d'une instance : `smtp-server` borne l'attente à `closeTimeout`. */
function close(server: SMTPServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    server.close(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });
  });
}

/**
 * Vrai si l'erreur est le refus d'identifiants de S5 — et lui seul.
 *
 * La comparaison porte sur **l'identité de la constante**, pas sur son code :
 * `535` pourrait un jour désigner autre chose, alors que
 * `SMTP_REPLY_AUTH_INVALID_CREDENTIALS` ne désigne que « identifiant inconnu,
 * révoqué, ou secret faux ». C'est exactement l'ensemble d'événements qui doit
 * nourrir les compteurs anti-bourrinage : ni le `538` d'une AUTH en clair (le
 * client n'a présenté aucun secret), ni le `451` d'une panne de base (la faute
 * est la nôtre).
 */
function isAuthCredentialFailure(error: unknown): boolean {
  return (
    isSmtpReplyError(error) &&
    error.smtpReply === SMTP_REPLY_AUTH_INVALID_CREDENTIALS
  );
}
