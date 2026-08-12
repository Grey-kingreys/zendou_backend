/**
 * Confirmation de l'adresse email — constantes de référence.
 */

/**
 * Octets aléatoires du jeton de confirmation : 32 octets (256 bits), tirés
 * par `randomBytes` et rendus en base64url — même calibre que le token de
 * session. Le deviner par force brute n'a pas de sens, ce qui dispense d'une
 * limitation de débit dédiée sur `POST /v1/auth/confirm-email` (la politique
 * globale de 120 req/min par identité s'y applique quand même).
 */
export const EMAIL_CONFIRMATION_TOKEN_BYTES = 32;

/**
 * Durée de vie du jeton : **24 heures**.
 *
 * Assez long pour l'usage réel visé — quelqu'un s'inscrit le soir depuis un
 * téléphone sur un réseau capricieux, l'email arrive avec du retard, il le lit
 * le lendemain matin — et pour absorber un passage de l'email par les
 * indésirables. Assez court pour qu'un lien resté dans une boîte partagée,
 * dans un historique de messagerie ou dans une archive exportée cesse vite
 * d'être une clé d'activation utilisable : ce lien confirme un compte **et**
 * déclenche l'octroi de 1 000 crédits. Le renvoi (`resend-confirmation`)
 * rend l'expiration indolore : un jeton périmé se remplace en un clic.
 */
export const EMAIL_CONFIRMATION_TTL_HOURS = 24;

/** Longueur maximale acceptée pour un jeton reçu (borne d'entrée, pas de sens métier). */
export const EMAIL_CONFIRMATION_TOKEN_MAX_LENGTH = 200;

/** Sujet de l'email de confirmation. */
export const CONFIRMATION_EMAIL_SUBJECT =
  'Confirmez votre adresse email — Zendou';

/** 400 — jeton inconnu, déjà remplacé, expiré, ou émis pour une autre adresse. */
export const INVALID_CONFIRMATION_TOKEN_MESSAGE =
  'Lien de confirmation invalide ou expiré. Demandez un nouveau lien depuis votre tableau de bord.';

/** 409 — le compte visé par ce jeton est déjà confirmé. */
export const ALREADY_CONFIRMED_MESSAGE = 'Cette adresse est déjà confirmée.';

/** 422 — l'adresse figure sur la liste de suppression : rien ne partira jamais. */
export const SUPPRESSED_ADDRESS_MESSAGE =
  "Cette adresse email est bloquée : un envoi précédent a définitivement échoué (adresse inexistante ou plainte). Aucun email ne peut lui être expédié — corrigez l'adresse du compte ou contactez le support.";

/**
 * 403 — message unique pour les deux surfaces fermées aux comptes non
 * confirmés : `POST /v1/emails` et la création de clé API.
 */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  "Adresse email non confirmée : confirmez votre adresse pour activer l'envoi d'emails et la création de clés API. Un lien vous a été envoyé à l'inscription ; vous pouvez en demander un nouveau depuis votre tableau de bord.";

/**
 * 503 — l'expédition système est impossible (`SYSTEM_EMAIL_FROM` absente, ou
 * son domaine non vérifié). C'est une erreur de configuration serveur, pas une
 * faute du client : on le dit plutôt que de répondre « envoyé » à un email qui
 * ne partira pas.
 */
export const CONFIRMATION_EMAIL_UNAVAILABLE_MESSAGE =
  "Envoi du lien de confirmation temporairement impossible. L'incident est enregistré ; réessayez dans quelques minutes.";
