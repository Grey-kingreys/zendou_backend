/** Longueur maximale du sujet d'un email. */
export const SUBJECT_MAX_LENGTH = 300;

/**
 * Taille maximale de chaque corps (`html`, `text`) : 500 Ko, mesurés en
 * octets UTF-8 — un accent compte donc pour 2.
 */
export const MAX_BODY_BYTES = 500 * 1024;

/**
 * Taille maximale d'un **message MIME entier** reçu par le relais SMTP
 * (B6 §4.5) : 10 Mo. Annoncée aux clients par la capacité `SIZE` de l'EHLO et
 * appliquée pendant le flux `DATA`.
 *
 * Distincte de {@link MAX_BODY_BYTES}, et pas seulement par sa valeur :
 * celle-là est une limite **par corps** (`html`, `text`), mesurée sur des
 * chaînes, qui ne peut pas servir de plafond à un message complet — une
 * facture PDF de 400 Ko pèse ~550 Ko une fois encodée en base64, avant même
 * les corps.
 *
 * **Valeur choisie : `min(10 Mo, limite réelle de SES)`** — l'hypothèse n°4 du
 * plan exigeait de lire la limite AWS plutôt que de la deviner. Elle est de
 * **40 Mo par message (après encodage base64)** pour l'API SES v2, celle
 * qu'utilise le driver (`@aws-sdk/client-sesv2`, `SendEmail`), contre 10 Mo
 * pour l'API v1 — source : « Service quotas in Amazon SES », section *Message
 * quotas* (https://docs.aws.amazon.com/ses/latest/dg/quotas.html), non
 * ajustable. La même page ajoute que « les messages de plus de 10 Mo sont
 * soumis à une limitation de bande passante » : 10 Mo est donc aussi le point
 * où SES cesse de livrer à pleine vitesse. Deux raisons de plus de s'y tenir :
 * le message brut voyage dans la charge utile BullMQ, donc en mémoire Redis
 * (A13), et il transite par l'event loop partagé avec l'API (§1.1).
 *
 * Réglable par `SMTP_MAX_MESSAGE_BYTES` : le porteur peut descendre (décision
 * B4 du §8) sans toucher au code. Monter au-delà de 40 Mo ne servirait à rien,
 * SES refuserait.
 */
export const MAX_RAW_MESSAGE_BYTES = 10 * 1024 * 1024;

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

/**
 * 503 — le domaine de `TEST_EMAIL_FROM` (mode bac à sable B20) n'est pas
 * `VERIFIED` dans Zendou. Erreur de configuration serveur, jamais une faute
 * du client : on le dit à l'acceptation, avant tout débit de crédit, plutôt
 * que de laisser l'envoi échouer bien plus tard chez SES. Même raisonnement
 * que `CONFIRMATION_EMAIL_UNAVAILABLE_MESSAGE` côté confirmation d'inscription.
 * Message volontairement neutre : le client n'a rien mal configuré, il n'y a
 * donc rien à lui demander de corriger.
 */
export const TEST_SENDER_UNAVAILABLE_MESSAGE =
  "Le mode d'envoi de test est momentanément indisponible. Réessayez dans quelques minutes, ou vérifiez un domaine pour envoyer dès maintenant.";

/** Message renvoyé quand le solde de crédits ne couvre pas l'envoi. */
export const INSUFFICIENT_CREDITS_MESSAGE =
  'Crédits insuffisants : rechargez votre compte pour continuer à envoyer.';

/** Message renvoyé quand le quota journalier du compte est atteint. */
export const DAILY_LIMIT_REACHED_MESSAGE =
  'Limite journalière atteinte : réessayez demain ou demandez une augmentation de quota.';

/**
 * 403 — le compte est suspendu (T12) et ne peut plus envoyer.
 *
 * Texte volontairement **identique** à `API_KEY_OWNER_SUSPENDED_MESSAGE`
 * (`api-keys.constants.ts`), que renvoie déjà `ApiKeyAuthGuard` : le contrôle
 * vit désormais aussi dans le point d'acceptation, pour fermer la règle à tout
 * appelant non-HTTP, et les deux surfaces doivent dire exactement la même
 * chose. La constante est dupliquée plutôt qu'importée pour ne pas faire
 * dépendre le service d'envoi du module des clés API.
 */
export const ACCOUNT_SUSPENDED_MESSAGE = 'Ce compte est suspendu';

/**
 * Motifs de refus du point d'acceptation (`EmailsService.accept`).
 *
 * Le point d'acceptation continue de lever des `HttpException` : c'est le
 * contrat de `POST /v1/emails` et il ne bouge pas. Mais un appelant non-HTTP
 * — le relais SMTP de B6 — doit choisir un code de réponse à partir du
 * **motif**, jamais d'un statut HTTP ni d'un message français :
 *
 * - plusieurs motifs partagent le même 403 (domaine non vérifié, compte
 *   suspendu, adresse non confirmée, restriction du bac à sable) ;
 * - deux motifs appellent des réponses SMTP opposées alors que rien ne les
 *   distingue côté HTTP : « crédits épuisés » est temporaire (`450 4.7.0`,
 *   le MTA du client relivrera après recharge) là où « domaine non vérifié »
 *   est définitif (`550 5.7.1`).
 *
 * Le motif est attaché à l'exception levée (`sendRefusalReason`,
 * `emails.service.ts`) : classe, statut et message des exceptions existantes
 * restent rigoureusement inchangés.
 */
export const SEND_REFUSAL = {
  /** Compte suspendu par la surveillance de réputation (T12). */
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  /** Adresse email du compte non confirmée. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** Adresse d'expédition illisible. */
  INVALID_FROM: 'INVALID_FROM',
  /** Adresse de destinataire illisible. */
  INVALID_TO: 'INVALID_TO',
  /** Ni `html` ni `text` fourni (contenu simple). */
  MISSING_BODY: 'MISSING_BODY',
  /** Un corps dépasse `MAX_BODY_BYTES` (contenu simple). */
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  /** Domaine d'expédition absent, non vérifié, ou appartenant à un tiers. */
  DOMAIN_NOT_VERIFIED: 'DOMAIN_NOT_VERIFIED',
  /** Mode bac à sable : le domaine de `TEST_EMAIL_FROM` n'est pas vérifié. */
  TEST_SENDER_UNAVAILABLE: 'TEST_SENDER_UNAVAILABLE',
  /** Mode bac à sable : destinataire autre que l'adresse du compte. */
  TEST_SENDER_RECIPIENT_RESTRICTED: 'TEST_SENDER_RECIPIENT_RESTRICTED',
  /** Solde de crédits insuffisant. */
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  /** Quota journalier du compte atteint. */
  DAILY_LIMIT_REACHED: 'DAILY_LIMIT_REACHED',
} as const;

/** Motif de refus du point d'acceptation, exploitable hors HTTP. */
export type SendRefusalReason =
  (typeof SEND_REFUSAL)[keyof typeof SEND_REFUSAL];

/**
 * Clé sous laquelle le motif est porté par l'exception levée.
 *
 * Un symbole, posé en propriété **non énumérable** : le motif ne doit
 * apparaître ni dans une sérialisation JSON, ni dans une comparaison
 * structurelle d'exception. Une `ForbiddenException` refusée reste, pour tout
 * code existant, exactement la `ForbiddenException` d'avant.
 */
export const SEND_REFUSAL_REASON = Symbol('zendou.send.refusalReason');
