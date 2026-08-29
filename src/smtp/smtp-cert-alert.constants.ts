/**
 * Surveillance de l'expiration du certificat TLS du relais SMTP (B6/H1).
 *
 * Le renouvellement du certificat est **manuel, tous les 90 jours** : le
 * porteur n'a pas d'accès root au VPS et remplace le couple certificat/clé à
 * la main dans les File Mounts Dokploy. Un oubli ne provoque aucune erreur
 * visible côté Zendou — il coupe simplement, en silence, tous les clients SMTP
 * (WordPress, ERP, CRM…) qui n'arrivent plus à établir la session TLS. Ce
 * module transforme cette panne silencieuse en signal.
 */

/**
 * Paliers d'alerte, en jours restants, du plus lointain au plus proche.
 *
 * **Une alerte par palier franchi**, jamais une par jour : à 20 jours on
 * notifie le palier 30 et plus rien jusqu'à 14. La sélection prend le **plus
 * petit** palier encore satisfait (`joursRestants <= palier`), ce qui garantit
 * qu'un palier déjà dépassé ne se redéclenche pas quand un palier plus serré
 * devient à son tour applicable.
 *
 * L'ordre décroissant est structurant : {@link smtpCertAlertThreshold} le lit
 * de gauche à droite et retient le dernier palier satisfait.
 */
export const SMTP_CERT_ALERT_THRESHOLDS_DAYS = [30, 14, 7, 3, 1] as const;

/**
 * Palier applicable pour un nombre de jours restants, ou `undefined` quand
 * l'expiration est encore lointaine (au-delà du plus grand palier).
 */
export function smtpCertAlertThreshold(
  daysRemaining: number,
): number | undefined {
  let selected: number | undefined;

  for (const threshold of SMTP_CERT_ALERT_THRESHOLDS_DAYS) {
    if (daysRemaining <= threshold) {
      selected = threshold;
    }
  }

  return selected;
}

/** Préfixe de toutes les clés Redis de la surveillance. */
export const SMTP_CERT_ALERT_KEY_PREFIX = 'smtp-cert-alert:';

/**
 * Jeton du client Redis dédié aux marqueurs d'alerte. Connexion distincte de
 * celle de l'anti-abus SMTP et de celle de BullMQ, comme `SMTP_THROTTLE_REDIS`
 * l'est déjà de `RATE_LIMIT_REDIS` : ce sont les **préfixes de clés** qui
 * séparent les usages, pas les connexions, mais deux cycles de vie sans
 * rapport n'ont pas à être couplés.
 */
export const SMTP_CERT_ALERT_REDIS = Symbol('SMTP_CERT_ALERT_REDIS');

/**
 * Empreinte utilisée dans la clé Redis quand il n'y a **pas** de certificat
 * lisible : fichier absent, illisible ou non analysable. Sans certificat, pas
 * de `fingerprint256` — mais il faut tout de même une clé stable pour ne pas
 * réémettre l'alerte chaque jour.
 */
export const SMTP_CERT_ALERT_NO_CERTIFICATE_FINGERPRINT = 'sans-certificat';

/** Motif de la clé Redis pour l'alerte « certificat déjà expiré ». */
export const SMTP_CERT_ALERT_EXPIRED_REASON = 'expire';

/** Motif de la clé Redis pour l'alerte « fichier absent ou illisible ». */
export const SMTP_CERT_ALERT_UNREADABLE_REASON = 'illisible';

/**
 * Durée de vie des marqueurs « palier déjà notifié ».
 *
 * 180 jours : le double du cycle de renouvellement manuel (90 jours), donc
 * toujours plus long que la vie utile du certificat qu'ils concernent — un
 * marqueur ne peut pas expirer avant l'échéance qu'il protège et rouvrir la
 * porte à un doublon. Au-delà, il se recycle tout seul : c'est ce TTL, combiné
 * à l'empreinte dans la clé, qui dispense d'écrire le moindre code de ménage.
 */
export const SMTP_CERT_ALERT_MARKER_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Intervalle du contrôle périodique : une fois par jour. */
export const SMTP_CERT_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Identifiant de la tâche répétable BullMQ. Stable : `upsertJobScheduler` est
 * idempotent sur cet identifiant, chaque redémarrage réinstalle la même tâche
 * au lieu d'en empiler une de plus.
 */
export const SMTP_CERT_ALERT_SCHEDULER_ID = 'smtp-cert-alert-quotidien';

/** Nom des jobs produits par la tâche répétable. */
export const SMTP_CERT_ALERT_JOB_NAME = 'smtp-cert-check';

/** Millisecondes dans une journée — base des calculs de jours restants. */
export const SMTP_CERT_ALERT_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Avertissement émis au démarrage quand ni `ALERTS_EMAIL_TO` ni `ADMIN_EMAIL`
 * ne sont renseignées : la surveillance tourne et journalise, mais n'a
 * personne à prévenir. Un démarrage n'échoue jamais pour cette raison.
 */
export const SMTP_CERT_ALERT_NO_RECIPIENT_MESSAGE =
  "Surveillance du certificat SMTP active mais sans destinataire : renseignez ALERTS_EMAIL_TO (ou ADMIN_EMAIL) pour recevoir les alertes d'expiration. En l'état, elles ne seront que journalisées.";
