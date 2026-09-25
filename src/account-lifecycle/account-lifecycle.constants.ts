/**
 * Cycle de vie des comptes (ANON-1) : anonymisation sur demande et traitement
 * des comptes inactifs, tels que promis par la politique de confidentialité
 * validée par le porteur le 25/09.
 *
 * Durées en constantes nommées, sans variable d'environnement : ce sont des
 * engagements publiés, pas des réglages d'exploitation. Les changer, c'est
 * changer la politique, donc le code et la page ensemble.
 */

/** Un compte sans activité depuis 24 mois est anonymisé. */
export const INACTIVITY_ANONYMIZE_AFTER_MONTHS = 24;

/** Il est prévenu par email à 23 mois d'inactivité... */
export const INACTIVITY_WARNING_AFTER_MONTHS = 23;

/**
 * ... et l'anonymisation n'intervient jamais moins de 30 jours après cet
 * avertissement, même si les 24 mois sont déjà atteints (avertissement tardif
 * après une panne, par exemple).
 */
export const INACTIVITY_WARNING_NOTICE_DAYS = 30;

/**
 * Intervalle minimal entre deux écritures de `User.lastActivityAt` pour un
 * même compte : une heure. La précision utile se compte en mois ; écrire à
 * chaque requête ou à chaque envoi chargerait la base pour rien.
 */
export const ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1000;

/** Nombre maximal de comptes traités par phase et par passage quotidien. */
export const INACTIVITY_SWEEP_BATCH_SIZE = 500;

/** Intervalle du passage périodique : une fois par jour. */
export const INACTIVITY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Identifiant stable de la tâche répétable BullMQ : `upsertJobScheduler` est
 * idempotent sur cet identifiant, un redémarrage ne l'empile pas.
 */
export const INACTIVITY_SCHEDULER_ID = 'comptes-inactifs-quotidien';

/** Nom des jobs produits par la tâche répétable. */
export const INACTIVITY_JOB_NAME = 'account-inactivity-sweep';

/** Millisecondes dans une journée. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Domaine des adresses de remplacement. `.invalid` est réservé par la
 * RFC 2606 (§2) : il ne sera jamais délégué dans le DNS, donc aucune adresse
 * `...@anonymise.invalid` ne peut recevoir de courrier ni appartenir un jour
 * à quelqu'un. Un domaine réel (même le nôtre) pourrait, lui, finir par
 * router : l'adresse d'un compte anonymisé ne doit pouvoir joindre personne.
 */
export const ANONYMIZED_EMAIL_DOMAIN = 'anonymise.invalid';

/** Adresse de remplacement, unique par compte (la colonne est `@unique`). */
export function anonymizedEmail(userId: string): string {
  return `anonymise-${userId}@${ANONYMIZED_EMAIL_DOMAIN}`;
}

/**
 * Masque un numéro de téléphone Mobile Money conservé dans une trace de
 * paiement (ANON-1) : seuls l'indicatif (`+` suivi de 3 chiffres, celui de la
 * Guinée) et les 4 derniers chiffres restent, séparés par `****` comme dans
 * `maskSecret`. Assez pour rapprocher une recharge d'un relevé opérateur avec
 * `transactionRef`, plus assez pour joindre ou identifier le payeur.
 *
 * `+224621112233` devient `+224****2233`. Un numéro trop court pour que ce
 * découpage cache quoi que ce soit est masqué en entier, sauf ses 4 derniers
 * chiffres s'il en a plus de 4.
 */
export function maskPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last4 = digits.slice(-4);

  if (digits.length <= 4) {
    return '****';
  }

  const prefix =
    value.trim().startsWith('+') && digits.length > 7
      ? `+${digits.slice(0, 3)}`
      : '';

  return `${prefix}****${last4}`;
}

/** Nom affiché d'un compte anonymisé. */
export const ANONYMIZED_NAME = 'Compte anonymisé';

/** Motif de suspension posé par une anonymisation demandée par un admin. */
export const ANONYMIZED_ON_REQUEST_REASON =
  "Compte anonymisé sur demande d'effacement des données personnelles.";

/** Motif de suspension posé par le traitement des comptes inactifs. */
export const ANONYMIZED_FOR_INACTIVITY_REASON = `Compte anonymisé automatiquement après ${INACTIVITY_ANONYMIZE_AFTER_MONTHS} mois d'inactivité.`;

export const SELF_ANONYMIZE_MESSAGE =
  'Un administrateur ne peut pas anonymiser son propre compte : demandez à un autre administrateur.';
export const ADMIN_ANONYMIZE_MESSAGE =
  "Ce compte est administrateur : il doit d'abord être rétrogradé en client avant de pouvoir être anonymisé.";
export const ALREADY_ANONYMIZED_MESSAGE = 'Ce compte est déjà anonymisé.';
export const ANONYMIZED_CANNOT_REACTIVATE_MESSAGE =
  'Ce compte est anonymisé : il ne peut pas être réactivé.';

/** Sujet de l'email d'avertissement d'inactivité. */
export const INACTIVITY_WARNING_SUBJECT_PREFIX =
  'Votre compte Zendou sera anonymisé le ';

/**
 * Ajoute (ou retire, si `months` est négatif) des mois calendaires, en UTC.
 * Le jour est borné au dernier jour du mois cible : 31 mars moins 1 mois
 * donne le 28 (ou 29) février, pas le 3 mars.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));

  return result;
}
