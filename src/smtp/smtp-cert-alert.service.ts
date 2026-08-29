import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { EmailsService } from '../emails/emails.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMTP_CERT_ALERT_DAY_MS,
  SMTP_CERT_ALERT_EXPIRED_REASON,
  SMTP_CERT_ALERT_KEY_PREFIX,
  SMTP_CERT_ALERT_MARKER_TTL_MS,
  SMTP_CERT_ALERT_NO_CERTIFICATE_FINGERPRINT,
  SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE,
  SMTP_CERT_ALERT_REDIS,
  SMTP_CERT_ALERT_UNREADABLE_REASON,
  smtpCertAlertThreshold,
} from './smtp-cert-alert.constants';
import {
  SMTP_CERT_ALERT_CLOCK,
  SMTP_CERT_INSPECTOR,
  type SmtpCertAlertClock,
  type SmtpCertificateInspector,
  type SmtpCertificateSnapshot,
} from './smtp-cert-alert.inspector';
import {
  SMTP_CERT_ALERT_SCHEDULER,
  type SmtpCertAlertScheduler,
} from './smtp-cert-alert.scheduler';
import {
  buildSmtpCertAlertEmail,
  type SmtpCertAlert,
} from './smtp-cert-alert.template';

/**
 * Surveillance de l'expiration du certificat TLS du relais SMTP (B6/H1).
 *
 * Le renouvellement est **manuel tous les 90 jours** — le porteur n'a pas
 * d'accès root au VPS. Un oubli ne casse rien de visible : il coupe en silence
 * tous les clients SMTP, qui n'arrivent plus à monter la session TLS. Ce
 * service est le signal qui manque à cette panne.
 *
 * Trois invariants, dans l'ordre d'importance :
 *
 * 1. **Inerte tant que `SMTP_RELAY_ENABLED` est faux.** C'est l'état par
 *    défaut de tous les environnements aujourd'hui : aucune tâche planifiée,
 *    aucune lecture de fichier, aucune commande Redis. Même règle et même
 *    formulation que `SmtpServerService`.
 * 2. **Rien de tout cela ne peut faire échouer un démarrage ni tuer un
 *    worker.** Un échec d'envoi (SES injoignable, adresse en liste de
 *    suppression, `SystemSenderUnavailableError`) est journalisé et avalé.
 *    Une surveillance qui fait tomber le service qu'elle surveille serait un
 *    marché de dupes.
 * 3. **Une alerte par palier franchi, pas une par jour.** Voir
 *    {@link claimMarker} pour la mécanique et le rôle de l'empreinte.
 */
@Injectable()
export class SmtpCertAlertService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SmtpCertAlertService.name);
  private started = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly emailsService: EmailsService,
    @Inject(SMTP_CERT_ALERT_REDIS)
    private readonly redis: Redis,
    @Inject(SMTP_CERT_INSPECTOR)
    private readonly inspect: SmtpCertificateInspector,
    @Inject(SMTP_CERT_ALERT_CLOCK)
    private readonly now: SmtpCertAlertClock,
    @Inject(SMTP_CERT_ALERT_SCHEDULER)
    private readonly scheduler: SmtpCertAlertScheduler,
  ) {}

  /**
   * Contrôle au démarrage **puis** installation de la tâche quotidienne.
   *
   * Le contrôle au démarrage n'est pas un doublon de la tâche répétable : il
   * attrape le cas « on déploie avec un certificat déjà proche de l'échéance »,
   * que la tâche ne verrait qu'au bout de vingt-quatre heures.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.configService.get<boolean>('SMTP_RELAY_ENABLED')) {
      this.logger.log(
        'Relais SMTP désactivé (SMTP_RELAY_ENABLED absent ou false) — certificat non surveillé',
      );
      return;
    }

    if (!this.resolveRecipient()) {
      this.logger.warn(SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE);
    }

    await this.runCheck();

    try {
      await this.scheduler.start(() => this.runCheck());
      this.started = true;
      this.logger.log(
        'Surveillance du certificat SMTP installée (contrôle quotidien)',
      );
    } catch (error: unknown) {
      // Invariant n°2 : Redis indisponible au démarrage ne doit pas empêcher
      // l'API de servir. Le contrôle au démarrage, lui, a déjà eu lieu.
      this.logger.error(
        'Impossible de planifier le contrôle quotidien du certificat SMTP',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) {
      try {
        await this.scheduler.stop();
      } catch (error: unknown) {
        this.logger.error(
          'Arrêt du planificateur de surveillance du certificat SMTP en erreur',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.redis.disconnect();
  }

  /**
   * Un contrôle complet. Exécuté au démarrage et par la tâche quotidienne.
   *
   * Ne rejette jamais : le worker BullMQ qui l'appelle n'a rien à réessayer —
   * le prochain contrôle est dans vingt-quatre heures de toute façon.
   */
  async runCheck(): Promise<void> {
    try {
      await this.check();
    } catch (error: unknown) {
      this.logger.error(
        'Contrôle du certificat SMTP en échec',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async check(): Promise<void> {
    const certPath = this.configService.get<string>('SMTP_TLS_CERT_PATH');

    if (!certPath) {
      // Hors production, un relais activé sans chemin sert le certificat
      // auto-signé intégré de `smtp-server` : il n'y a rien à surveiller. En
      // production, le `refine` d'`env.schema.ts` rend ce cas impossible.
      this.logger.warn(
        'Certificat du relais SMTP non surveillé : SMTP_TLS_CERT_PATH non renseignée',
      );
      return;
    }

    let snapshot: SmtpCertificateSnapshot;

    try {
      snapshot = this.inspect(certPath);
    } catch (error: unknown) {
      await this.raise({
        kind: 'unreadable',
        certPath,
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const nowMs = this.now().getTime();
    const expiresMs = snapshot.expiresAt.getTime();

    if (expiresMs <= nowMs) {
      await this.raise({
        kind: 'expired',
        snapshot,
        daysExpired: Math.floor((nowMs - expiresMs) / SMTP_CERT_ALERT_DAY_MS),
      });
      return;
    }

    // Arrondi **au plancher** : à 7 jours et 12 heures d'échéance il reste 7
    // jours, pas 8. Un arrondi vers le haut retarderait chaque alerte d'un
    // jour entier, ce qui, au palier « 1 jour », revient à ne pas alerter.
    const daysRemaining = Math.floor(
      (expiresMs - nowMs) / SMTP_CERT_ALERT_DAY_MS,
    );
    const threshold = smtpCertAlertThreshold(daysRemaining);

    if (threshold === undefined) {
      this.logger.log(
        `Certificat SMTP ${snapshot.subjectName} valide encore ${daysRemaining} jours — aucune alerte`,
      );
      return;
    }

    await this.raise({ kind: 'threshold', snapshot, daysRemaining, threshold });
  }

  /**
   * Journalise l'alerte, puis l'expédie si — et une seule fois par palier et
   * par certificat — elle n'a pas déjà été envoyée.
   */
  private async raise(alert: SmtpCertAlert): Promise<void> {
    // Journalisé d'abord, systématiquement : même sans destinataire, même si
    // l'envoi échoue, l'exploitation doit trouver la trace dans les logs.
    this.logger.error(describeAlert(alert));

    const to = this.resolveRecipient();

    if (!to) {
      // L'avertissement a déjà été émis au démarrage ; le répéter à chaque
      // contrôle noierait le journal.
      return;
    }

    const key = this.markerKey(alert);

    if (!(await this.claimMarker(key))) {
      return;
    }

    try {
      await this.send(to, alert);
    } catch (error: unknown) {
      // Invariant n°2 : l'échec d'envoi est journalisé et avalé. Le marqueur
      // est relâché — un palier marqué sans qu'aucun email ne soit parti
      // ferait taire l'alarme pour de bon, ce qui est exactement la panne
      // silencieuse que ce module existe pour empêcher. Le prochain contrôle
      // réessaiera.
      this.logger.error(
        `Alerte certificat SMTP non expédiée à ${to}`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.releaseMarker(key);
    }
  }

  private async send(to: string, alert: SmtpCertAlert): Promise<void> {
    // `sendSystem` trace la ligne `Email` sur un compte : le destinataire doit
    // exister dans Zendou. C'est naturellement le cas d'`ADMIN_EMAIL` (créé
    // par `AdminSeedService`) ; pour une `ALERTS_EMAIL_TO` arbitraire, on le
    // dit plutôt que d'échouer sur une contrainte de clé étrangère.
    const user = await this.prisma.user.findUnique({
      where: { email: to },
      select: { id: true },
    });

    if (!user) {
      throw new Error(
        `aucun compte Zendou ne porte l'adresse ${to} (ALERTS_EMAIL_TO / ADMIN_EMAIL)`,
      );
    }

    const { subject, html, text } = buildSmtpCertAlertEmail(alert);

    const result = await this.emailsService.sendSystem({
      userId: user.id,
      to,
      subject,
      html,
      text,
    });

    if (result.status === 'suppressed') {
      // Remonté comme un échec pour que le marqueur soit relâché : l'alerte
      // n'est jamais arrivée, elle ne doit pas compter comme envoyée.
      throw new Error(`${to} est sur la liste de suppression`);
    }

    this.logger.log(`Alerte certificat SMTP expédiée à ${to} : ${subject}`);
  }

  /**
   * Destinataire des alertes : `ALERTS_EMAIL_TO`, à défaut `ADMIN_EMAIL`.
   * Normalisé comme partout ailleurs (`auth.service.ts`, `admin-seed.service`)
   * pour retrouver le compte quelle que soit la casse de la variable.
   */
  private resolveRecipient(): string | null {
    const configured =
      this.configService.get<string>('ALERTS_EMAIL_TO') ??
      this.configService.get<string>('ADMIN_EMAIL');
    const normalized = configured?.trim().toLowerCase();

    return normalized ? normalized : null;
  }

  /**
   * Clé du marqueur « cette alerte a déjà été envoyée ».
   *
   * **L'empreinte du certificat est dans la clé, et c'est tout le mécanisme
   * d'anti-spam.** Un certificat renouvelé porte un `fingerprint256` neuf,
   * donc des clés neuves, donc des paliers vierges : les compteurs se
   * réinitialisent d'eux-mêmes, sans tâche de nettoyage, sans invalidation à
   * écrire, sans risque qu'un oubli de ménage fasse taire la surveillance du
   * certificat suivant. Les clés du certificat retiré ne sont même pas
   * supprimées : leur TTL s'en charge.
   *
   * Sans certificat lisible il n'y a pas d'empreinte — d'où l'empreinte
   * sentinelle `sans-certificat`, qui vaut la même promesse : une alerte, pas
   * une par jour, et le retour d'un fichier valide crée de toute façon des
   * clés différentes.
   */
  private markerKey(alert: SmtpCertAlert): string {
    switch (alert.kind) {
      case 'threshold':
        return `${SMTP_CERT_ALERT_KEY_PREFIX}${alert.snapshot.fingerprint}:j${alert.threshold}`;
      case 'expired':
        return `${SMTP_CERT_ALERT_KEY_PREFIX}${alert.snapshot.fingerprint}:${SMTP_CERT_ALERT_EXPIRED_REASON}`;
      case 'unreadable':
        return `${SMTP_CERT_ALERT_KEY_PREFIX}${SMTP_CERT_ALERT_NO_CERTIFICATE_FINGERPRINT}:${SMTP_CERT_ALERT_UNREADABLE_REASON}`;
    }
  }

  /**
   * Réserve le marqueur. `SET … NX` : la réservation et le test d'existence
   * sont une seule opération atomique, donc deux répliques qui contrôlent en
   * même temps n'envoient qu'un email — le second `SET` rend `null`.
   *
   * Redis injoignable : on alerte quand même. Un doublon d'email coûte une
   * seconde d'agacement ; une alerte d'expiration perdue coûte le service.
   */
  private async claimMarker(key: string): Promise<boolean> {
    try {
      const claimed = await this.redis.set(
        key,
        '1',
        'PX',
        SMTP_CERT_ALERT_MARKER_TTL_MS,
        'NX',
      );

      return claimed === 'OK';
    } catch (error: unknown) {
      this.logger.error(
        `Redis injoignable (${key}) — alerte émise sans mémorisation du palier`,
        error instanceof Error ? error.stack : String(error),
      );

      return true;
    }
  }

  private async releaseMarker(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error: unknown) {
      this.logger.error(
        `Marqueur ${key} non relâché — la prochaine alerte de ce palier pourrait manquer`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** Ligne de journal décrivant l'alerte, dans les mêmes termes que l'email. */
function describeAlert(alert: SmtpCertAlert): string {
  switch (alert.kind) {
    case 'threshold':
      return `Certificat SMTP ${alert.snapshot.subjectName} : expire dans ${alert.daysRemaining} jours (palier ${alert.threshold}), le ${alert.snapshot.expiresAt.toISOString()}`;
    case 'expired':
      return `Certificat SMTP ${alert.snapshot.subjectName} : EXPIRÉ depuis ${alert.daysExpired} jours, le ${alert.snapshot.expiresAt.toISOString()}`;
    case 'unreadable':
      return `Certificat SMTP illisible (${alert.certPath}) : ${alert.detail}`;
  }
}
