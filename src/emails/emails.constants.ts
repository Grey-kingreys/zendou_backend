/** Longueur maximale du sujet d'un email. */
export const SUBJECT_MAX_LENGTH = 300;

/**
 * Taille maximale de chaque corps (`html`, `text`) : 500 Ko, mesurés en
 * octets UTF-8 — un accent compte donc pour 2.
 */
export const MAX_BODY_BYTES = 500 * 1024;

/** Nombre de crédits consommés par email accepté. */
export const CREDITS_PER_EMAIL = 1;

/** Valeur inscrite dans `CreditEntry.reason` lors d'un débit d'envoi. */
export const CREDIT_REASON_SEND = 'SEND';

/**
 * Message d'erreur interne quand un envoi système ne peut pas partir :
 * `SYSTEM_EMAIL_FROM` absente, illisible, ou domaine d'expédition non vérifié.
 * Jamais renvoyé tel quel au client (voir
 * `CONFIRMATION_EMAIL_UNAVAILABLE_MESSAGE`), uniquement journalisé.
 */
export const SYSTEM_SENDER_UNAVAILABLE_MESSAGE =
  "Expédition système indisponible : SYSTEM_EMAIL_FROM absente, invalide, ou domaine d'expédition non vérifié dans Zendou.";

/** Préfixe des identifiants publics d'email (`e_` + 12 hexadécimaux). */
export const EMAIL_PUBLIC_ID_PREFIX = 'e_';

/** Octets aléatoires d'un identifiant public : 6 octets → 12 caractères hex. */
export const EMAIL_PUBLIC_ID_BYTES = 6;

/** Nom du job BullMQ déposé sur la file d'envoi. */
export const EMAIL_SEND_JOB = 'send';

/** Nombre de tentatives d'envoi avant abandon définitif. */
export const SEND_JOB_ATTEMPTS = 5;

/** Délai de base du backoff exponentiel entre deux tentatives (30 s). */
export const SEND_JOB_BACKOFF_DELAY_MS = 30_000;

/** Longueur maximale d'un message d'erreur persisté sur l'email. */
export const ERROR_MESSAGE_MAX_LENGTH = 1_000;

/** Message renvoyé pour une adresse d'expédition illisible. */
export const INVALID_FROM_MESSAGE =
  "L'adresse d'expédition est invalide : utilisez « adresse@domaine » ou « Nom <adresse@domaine> ».";

/** Message renvoyé pour une adresse de destinataire illisible. */
export const INVALID_TO_MESSAGE =
  "L'adresse du destinataire est invalide : indiquez une seule adresse comme « client@exemple.gn ».";

/** Message renvoyé pour un sujet vide ou trop long. */
export const SUBJECT_LENGTH_MESSAGE = `Le sujet est obligatoire et ne doit pas dépasser ${SUBJECT_MAX_LENGTH} caractères.`;

/** Message renvoyé quand ni `html` ni `text` n'est fourni. */
export const MISSING_BODY_MESSAGE =
  'Fournissez au moins un contenu : « html » ou « text ».';

/** Message renvoyé quand un corps dépasse la taille autorisée. */
export const BODY_TOO_LARGE_MESSAGE =
  'Chaque contenu (« html », « text ») est limité à 500 Ko.';

/** Message renvoyé quand le domaine de l'expéditeur n'est pas utilisable. */
export const DOMAIN_NOT_VERIFIED_MESSAGE =
  "Le domaine d'envoi n'est pas vérifié : ajoutez-le à votre compte et validez ses enregistrements DNS avant d'envoyer.";

/**
 * Message renvoyé quand un envoi depuis l'adresse de test (`TEST_EMAIL_FROM`,
 * mode bac à sable B20) cible un destinataire autre que l'adresse du compte
 * appelant. Explique le mode plutôt que de refuser sèchement : cette
 * restriction n'est pas arbitraire, c'est ce qui protège la réputation du
 * domaine d'expédition partagé — le même qui expédie les emails de
 * confirmation d'inscription. Voir
 * `EmailsService.requireOwnAddressAsRecipient`.
 */
export const TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE =
  "Depuis l'adresse de test, vous ne pouvez écrire qu'à l'adresse email de votre compte. Vérifiez un domaine pour écrire à vos utilisateurs.";

/** Message renvoyé quand le solde de crédits ne couvre pas l'envoi. */
export const INSUFFICIENT_CREDITS_MESSAGE =
  'Crédits insuffisants : rechargez votre compte pour continuer à envoyer.';

/** Message renvoyé quand le quota journalier du compte est atteint. */
export const DAILY_LIMIT_REACHED_MESSAGE =
  'Limite journalière atteinte : réessayez demain ou demandez une augmentation de quota.';
