import { FAILED_EMAIL_JOB_RETENTION_SECONDS } from '../emails/emails.constants';

/**
 * Rétention automatique des données d'envoi (RET-12), promesse de la
 * politique de confidentialité validée par le porteur le 25/09 :
 *
 * 1. **Corps des jobs en échec définitif : 7 jours.** `removeOnFail` (posé à
 *    la mise en file, voir `FAILED_EMAIL_JOB_RETENTION_SECONDS`) ne couvre
 *    que les jobs qui échouent après son introduction. Le nettoyage
 *    quotidien de ce fichier rattrape aussi les jobs déjà en échec avant le
 *    déploiement, quel que soit leur âge de création : `queue.clean` filtre
 *    sur l'âge du job **dans son état actuel** (`finishedOn` pour un job en
 *    échec), pas sur sa date de création.
 * 2. **Journal des envois (`Email`) : 6 mois.** Purge des lignes dont
 *    `queuedAt` dépasse ce seuil.
 *
 * Durées en constantes, pas en variables d'environnement : ce sont des
 * engagements pris envers les utilisateurs dans un document public, pas un
 * réglage d'exploitation.
 */

/**
 * Grâce (en **millisecondes**, unité de `Queue.clean`) sous laquelle un job
 * en échec est éligible au nettoyage quotidien.
 *
 * Dérivée de {@link FAILED_EMAIL_JOB_RETENTION_SECONDS} plutôt que
 * redéfinie : les deux mécanismes (`removeOnFail` à la mise en file,
 * `queue.clean` au nettoyage quotidien) appliquent la même promesse, 7
 * jours, sous deux API BullMQ dont les unités diffèrent (secondes contre
 * millisecondes). Une seule constante source évite qu'elles divergent un
 * jour sans que ce soit délibéré.
 */
export const FAILED_JOB_CLEAN_GRACE_MS =
  FAILED_EMAIL_JOB_RETENTION_SECONDS * 1000;

/**
 * Nombre maximal de jobs supprimés par appel à `queue.clean`. `clean` ne
 * boucle pas tout seul jusqu'à épuisement : c'est `RetentionService` qui
 * rappelle `clean` tant qu'un appel renvoie une liste pleine (indice qu'il en
 * restait potentiellement d'autres), par lots bornés plutôt qu'en une seule
 * commande Redis susceptible de bloquer le serveur sur un très gros historique.
 */
export const FAILED_JOB_CLEAN_BATCH_LIMIT = 1_000;

/**
 * Ancienneté, en mois civils, au-delà de laquelle une ligne `Email` est
 * purgée. Calculée sur `queuedAt` (indexé depuis la vague 7,
 * `@@index([userId, queuedAt])`) plutôt que sur une autre date du cycle de
 * vie de l'email (`sentAt`, `deliveredAt`, `lastEventAt`, toutes trois
 * nullables : un email jamais parti ou jamais confirmé par SES n'en a pas).
 * `queuedAt` est la seule date **garantie non nulle sur toute ligne**,
 * posée par défaut à la création, donc la seule sur laquelle un seuil de
 * purge peut s'appliquer sans branche « et si cette date est absente ? ».
 * Mois civils (`setUTCMonth`) plutôt qu'un compte de jours fixe : c'est la
 * lecture naturelle de « 6 mois » dans la politique de confidentialité, et
 * elle évite la dérive d'un compte en jours qui glisserait d'année en année
 * (années bissextiles, mois de longueurs différentes).
 */
export const EMAIL_LOG_RETENTION_MONTHS = 6;

/**
 * Instant avant lequel une ligne `Email` est purgée, calculé à partir de
 * `now`. Fonction pure et testable : `RetentionService` ne calcule jamais
 * l'instant courant lui-même (voir `RETENTION_CLOCK`).
 */
export function emailLogRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - EMAIL_LOG_RETENTION_MONTHS);
  return cutoff;
}

/**
 * Nombre de lignes `Email` supprimées par lot. Comme
 * {@link FAILED_JOB_CLEAN_BATCH_LIMIT} : jamais un `deleteMany` unique sur
 * tout l'historique, qui verrouillerait la table le temps de balayer des
 * millions de lignes. `RetentionService` sélectionne un lot d'identifiants,
 * les supprime, et recommence tant qu'un lot plein a été trouvé.
 */
export const EMAIL_LOG_DELETE_BATCH_SIZE = 500;

/** Intervalle du nettoyage quotidien : une fois par jour, comme B6/H1. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Identifiant de la tâche répétable BullMQ. Stable : `upsertJobScheduler` est
 * idempotent sur cet identifiant, chaque redémarrage réinstalle la même tâche
 * au lieu d'en empiler une de plus.
 */
export const RETENTION_SCHEDULER_ID = 'retention-purge-quotidienne';

/** Nom des jobs produits par la tâche répétable. */
export const RETENTION_JOB_NAME = 'retention-purge';

/**
 * Horloge injectée dans `RetentionService`, même mécanique que
 * `SMTP_CERT_ALERT_CLOCK` (`smtp-cert-alert.inspector.ts`) : un test qui
 * calculerait le seuil de 6 mois à partir de l'heure réelle du poste devrait
 * recalculer son attendu à chaque exécution, ou pire, dater ses fixtures en
 * relatif et perdre en lisibilité.
 */
export type RetentionClock = () => Date;

/** Jeton d'injection de l'horloge {@link RetentionClock}. */
export const RETENTION_CLOCK = Symbol('RETENTION_CLOCK');
