import { HttpException } from '@nestjs/common';
import { EMAIL_NOT_VERIFIED_MESSAGE } from '../auth/email-confirmation.constants';
import {
  ACCOUNT_SUSPENDED_MESSAGE,
  DAILY_LIMIT_REACHED_MESSAGE,
  DOMAIN_NOT_VERIFIED_MESSAGE,
  INSUFFICIENT_CREDITS_MESSAGE,
  INVALID_FROM_MESSAGE,
  INVALID_REPLY_TO_MESSAGE,
  INVALID_TO_MESSAGE,
  REPLY_TO_NOT_VERIFIED_MESSAGE,
  SEND_REFUSAL,
  TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
  TEST_SENDER_UNAVAILABLE_MESSAGE,
  type SendRefusalReason,
} from '../emails/emails.constants';
import { sendRefusalReason } from '../emails/emails.service';

/**
 * Réponse SMTP à trois champs (RFC 5321 §4.2 + RFC 3463 — statuts étendus) :
 * `code` est le code numérique à trois chiffres, `enhancedStatus` le statut
 * étendu (`classe.sujet.détail`) qui l'accompagne, `message` le texte lisible
 * renvoyé au client. Voir `docs/plans/B6-RELAIS-SMTP.md` §4.4 pour le tableau
 * dont ce module est la traduction en code.
 */
export interface SmtpReply {
  code: number;
  enhancedStatus: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Refus qui passent par `EmailsService.accept()` — un par motif `SEND_REFUSAL`
// (`emails.constants.ts`). Chaque constante cite la ligne du tableau §4.4
// dont elle est la traduction, et réutilise — plutôt que de la reformuler —
// le message français déjà approuvé pour ce motif ailleurs dans le produit :
// c'est le même refus, vu d'un canal différent, il doit dire la même chose.
// ---------------------------------------------------------------------------

/** §4.4 « Compte suspendu (T12) » — MAIL FROM — 550 5.7.1, définitif. */
export const SMTP_REPLY_ACCOUNT_SUSPENDED: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: ACCOUNT_SUSPENDED_MESSAGE,
};

/** §4.4 « Adresse du compte non confirmée » — MAIL FROM — 550 5.7.1. */
export const SMTP_REPLY_EMAIL_NOT_VERIFIED: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: EMAIL_NOT_VERIFIED_MESSAGE,
};

/**
 * §4.4 « MAIL FROM illisible » — MAIL FROM — 501 5.1.7, syntaxe.
 *
 * Partagée entre deux usages : c'est à la fois la réponse du motif
 * `SEND_REFUSAL.INVALID_FROM` (le contrôle de `accept()`, en fin de DATA, sur
 * l'en-tête `From:`) et la constante que S7 doit réutiliser telle quelle pour
 * son propre contrôle anticipé, au niveau de l'enveloppe `MAIL FROM` — même
 * validateur (`parseEmailAddress`), même défaut, donc même réponse.
 */
export const SMTP_REPLY_MAIL_FROM_UNREADABLE: SmtpReply = {
  code: 501,
  enhancedStatus: '5.1.7',
  message: INVALID_FROM_MESSAGE,
};

/**
 * §4.4 « RCPT TO illisible » — RCPT TO — 501 5.1.3, syntaxe.
 *
 * Même logique de partage que {@link SMTP_REPLY_MAIL_FROM_UNREADABLE} : sert
 * à la fois au motif `SEND_REFUSAL.INVALID_TO` et au contrôle anticipé de
 * S7 sur chaque `RCPT TO`.
 */
export const SMTP_REPLY_RCPT_TO_UNREADABLE: SmtpReply = {
  code: 501,
  enhancedStatus: '5.1.3',
  message: INVALID_TO_MESSAGE,
};

/**
 * « `Reply-To:` illisible » - fin DATA - 501 5.1.7, syntaxe.
 *
 * Même code et même statut étendu que {@link SMTP_REPLY_MAIL_FROM_UNREADABLE},
 * et pour la même raison : c'est le même validateur d'adresse qui a refusé, sur
 * un en-tête au lieu d'une enveloppe. Message distinct, en revanche - le client
 * doit savoir **laquelle** de ses adresses il doit corriger.
 */
export const SMTP_REPLY_REPLY_TO_UNREADABLE: SmtpReply = {
  code: 501,
  enhancedStatus: '5.1.7',
  message: INVALID_REPLY_TO_MESSAGE,
};

/**
 * « Domaine du `Reply-To:` non vérifié ou non possédé » - fin DATA -
 * 550 5.7.1, définitif.
 *
 * Même famille que {@link SMTP_REPLY_DOMAIN_NOT_VERIFIED}, dont c'est la règle
 * appliquée à l'adresse de réponse : sans elle, un client expédie depuis son
 * propre domaine et fait atterrir la conversation chez un tiers, sous notre
 * signature DKIM. Définitif : ce n'est pas une indisponibilité, c'est un
 * domaine que le client doit ajouter et vérifier.
 */
export const SMTP_REPLY_REPLY_TO_NOT_VERIFIED: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: REPLY_TO_NOT_VERIFIED_MESSAGE,
};

/**
 * `SEND_REFUSAL.MISSING_BODY` n'a **pas** de ligne dédiée au §4.4 : ce motif
 * ne concerne que le contenu `simple` (ni `html` ni `text` fourni), et le
 * canal SMTP est Raw de bout en bout (§4.5/A8) — `accept()` ne peut donc
 * jamais lever ce refus pour un envoi SMTP. Il reste dans cette table pour
 * l'exhaustivité exigée par le typage (`Record<SendRefusalReason, …>`) et par
 * le test d'exhaustivité (S8), au cas où un appelant non-HTTP futur
 * réutiliserait `accept()` en contenu `simple`. Code choisi par le repli
 * générique du §4.4 : « un `HttpException` 4xx inconnue → 550 5.7.1 » — ce
 * motif lève une `BadRequestException` (400), un 4xx sans ligne dédiée.
 */
export const SMTP_REPLY_MISSING_BODY: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: 'Contenu manquant : ce message ne peut pas être accepté.',
};

/**
 * `SEND_REFUSAL.BODY_TOO_LARGE` : même situation que
 * {@link SMTP_REPLY_MISSING_BODY} — motif du contenu `simple`, inatteignable
 * via le canal SMTP (Raw de bout en bout), présent uniquement pour
 * l'exhaustivité. Même repli : `BadRequestException` (400), 4xx inconnue au
 * §4.4 → 550 5.7.1.
 */
export const SMTP_REPLY_BODY_TOO_LARGE: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: 'Contenu trop volumineux : ce message ne peut pas être accepté.',
};

/** §4.4 « Domaine From non vérifié ou non possédé » — fin DATA — 550 5.7.1, définitif. */
export const SMTP_REPLY_DOMAIN_NOT_VERIFIED: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: DOMAIN_NOT_VERIFIED_MESSAGE,
};

/**
 * §4.4 « Domaine de `TEST_EMAIL_FROM` non VERIFIED (mauvaise config Zendou) »
 * — fin DATA — 451 4.3.0. Notre faute, pas celle du client : temporaire.
 */
export const SMTP_REPLY_TEST_SENDER_UNAVAILABLE: SmtpReply = {
  code: 451,
  enhancedStatus: '4.3.0',
  message: TEST_SENDER_UNAVAILABLE_MESSAGE,
};

/**
 * §4.4 « From = adresse de test, destinataire ≠ adresse du compte » — fin
 * DATA — 550 5.7.1, restriction du bac à sable.
 */
export const SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: TEST_SENDER_RECIPIENT_RESTRICTED_MESSAGE,
};

/**
 * §4.4 « Crédits épuisés » — MAIL FROM — 450 4.7.0, **temporaire** : après
 * recharge, le MTA du client relivre tout seul (A10).
 */
export const SMTP_REPLY_INSUFFICIENT_CREDITS: SmtpReply = {
  code: 450,
  enhancedStatus: '4.7.0',
  message: INSUFFICIENT_CREDITS_MESSAGE,
};

/**
 * §4.4 « Quota journalier atteint » — MAIL FROM — 451 4.7.0, temporaire : se
 * réinitialise à minuit UTC (A11).
 */
export const SMTP_REPLY_DAILY_LIMIT_REACHED: SmtpReply = {
  code: 451,
  enhancedStatus: '4.7.0',
  message: DAILY_LIMIT_REACHED_MESSAGE,
};

/**
 * Table de correspondance `SEND_REFUSAL` → réponse SMTP.
 *
 * Le typage `Record<SendRefusalReason, SmtpReply>` donne l'exhaustivité **à
 * la compilation** : si un motif est ajouté à `SEND_REFUSAL`
 * (`emails.constants.ts`) sans qu'une entrée ne soit ajoutée ici, `tsc` refuse
 * de compiler (propriété manquante). Le test d'exhaustivité
 * (`smtp-reply.spec.ts`) donne la même garantie **à l'exécution**, pour un
 * appelant qui contournerait le typage (`as any`, JavaScript pur).
 */
export const SEND_REFUSAL_SMTP_REPLY: Record<SendRefusalReason, SmtpReply> = {
  [SEND_REFUSAL.ACCOUNT_SUSPENDED]: SMTP_REPLY_ACCOUNT_SUSPENDED,
  [SEND_REFUSAL.EMAIL_NOT_VERIFIED]: SMTP_REPLY_EMAIL_NOT_VERIFIED,
  [SEND_REFUSAL.INVALID_FROM]: SMTP_REPLY_MAIL_FROM_UNREADABLE,
  [SEND_REFUSAL.INVALID_TO]: SMTP_REPLY_RCPT_TO_UNREADABLE,
  [SEND_REFUSAL.INVALID_REPLY_TO]: SMTP_REPLY_REPLY_TO_UNREADABLE,
  [SEND_REFUSAL.REPLY_TO_NOT_VERIFIED]: SMTP_REPLY_REPLY_TO_NOT_VERIFIED,
  [SEND_REFUSAL.MISSING_BODY]: SMTP_REPLY_MISSING_BODY,
  [SEND_REFUSAL.BODY_TOO_LARGE]: SMTP_REPLY_BODY_TOO_LARGE,
  [SEND_REFUSAL.DOMAIN_NOT_VERIFIED]: SMTP_REPLY_DOMAIN_NOT_VERIFIED,
  [SEND_REFUSAL.TEST_SENDER_UNAVAILABLE]: SMTP_REPLY_TEST_SENDER_UNAVAILABLE,
  [SEND_REFUSAL.TEST_SENDER_RECIPIENT_RESTRICTED]:
    SMTP_REPLY_TEST_SENDER_RECIPIENT_RESTRICTED,
  [SEND_REFUSAL.INSUFFICIENT_CREDITS]: SMTP_REPLY_INSUFFICIENT_CREDITS,
  [SEND_REFUSAL.DAILY_LIMIT_REACHED]: SMTP_REPLY_DAILY_LIMIT_REACHED,
};

// ---------------------------------------------------------------------------
// Refus qui ne passent PAS par `accept()` — S5 (connexion, AUTH) et S7
// (MAIL FROM / RCPT TO / DATA) les lèvent directement depuis la session
// `smtp-server`, avant même d'appeler le point d'acceptation. Exportées ici
// pour que ni S5 ni S7 n'invente son propre littéral de code — la même règle
// que pour la table ci-dessus, appliquée à la conversation SMTP elle-même.
// ---------------------------------------------------------------------------

/** §4.4 « Trop de connexions depuis cette IP » — CONNECT — 421 4.7.0 + fermeture. */
export const SMTP_REPLY_TOO_MANY_CONNECTIONS: SmtpReply = {
  code: 421,
  enhancedStatus: '4.7.0',
  message: 'Trop de connexions depuis cette adresse IP.',
};

/** §4.4 « AUTH tenté sans chiffrement (prod) » — AUTH — 538 5.7.11 (RFC 4954). */
export const SMTP_REPLY_AUTH_REQUIRES_TLS: SmtpReply = {
  code: 538,
  enhancedStatus: '5.7.11',
  message:
    'Authentification refusée avant chiffrement : démarrez STARTTLS avant AUTH.',
};

/**
 * §4.4 « Identifiants inconnus / faux / révoqués » — AUTH — 535 5.7.8
 * (RFC 4954). Le tableau est explicite : **message identique dans les trois
 * cas** — identifiant inconnu, mot de passe faux, ou identifiant révoqué —
 * pour ne donner aucun oracle d'énumération des noms d'utilisateur valides.
 */
export const SMTP_REPLY_AUTH_INVALID_CREDENTIALS: SmtpReply = {
  code: 535,
  enhancedStatus: '5.7.8',
  message: 'Authentification refusée : identifiant ou mot de passe invalide.',
};

/**
 * §4.4 « `MAIL FROM` sans authentification » — MAIL FROM — 530 5.7.0. Pas
 * d'open relay (§5) : ce refus doit tomber avant tout autre contrôle dès
 * qu'aucune session authentifiée n'est associée à la connexion.
 */
export const SMTP_REPLY_MAIL_FROM_REQUIRES_AUTH: SmtpReply = {
  code: 530,
  enhancedStatus: '5.7.0',
  message: 'Authentification requise avant MAIL FROM.',
};

/**
 * §4.4 « `SIZE=` annoncé > plafond » (MAIL FROM) et « Message > plafond,
 * constaté pendant DATA » (DATA) — deux lignes du tableau, même code et même
 * statut étendu (552 5.3.4), donc une seule constante : que le dépassement
 * soit détecté avant l'envoi (annonce `SIZE`) ou pendant le flux (`DATA`), la
 * réponse au client est la même.
 */
export const SMTP_REPLY_SIZE_EXCEEDED: SmtpReply = {
  code: 552,
  enhancedStatus: '5.3.4',
  message:
    'Message trop volumineux : la taille dépasse la limite autorisée par ce relais.',
};

/** §4.4 « Trop de destinataires » — RCPT TO — 452 4.5.3. */
export const SMTP_REPLY_TOO_MANY_RECIPIENTS: SmtpReply = {
  code: 452,
  enhancedStatus: '4.5.3',
  message: 'Trop de destinataires pour ce message.',
};

/** §4.4 « MIME illisible / plusieurs `From:` » — fin DATA — 554 5.6.0, contenu invalide. */
export const SMTP_REPLY_MIME_INVALID: SmtpReply = {
  code: 554,
  enhancedStatus: '5.6.0',
  message: 'Message MIME invalide, ou plusieurs en-têtes « From: ».',
};

// ---------------------------------------------------------------------------
// Replis (§4.4, dernier paragraphe) : pour un refus non cartographié —
// c'est-à-dire quand `sendRefusalReason` ne rend aucun motif — jamais `250`.
// ---------------------------------------------------------------------------

/**
 * Repli « `HttpException` 4xx inconnue » : une erreur HTTP porte un statut
 * client (400–499) mais n'est pas un refus de `accept()` — `sendRefusalReason`
 * rend `null`. Définitif, comme la plupart des refus 550 du tableau : on
 * suppose que c'est au client de corriger quelque chose.
 */
export const SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL: SmtpReply = {
  code: 550,
  enhancedStatus: '5.7.1',
  message: 'Envoi refusé.',
};

/**
 * Repli « tout le reste » : `HttpException` non-4xx, ou erreur qui n'est même
 * pas une `HttpException` (panne base, Redis, bug). Correspond aussi à la
 * ligne §4.4 « SES / base / Redis indisponible » (fin DATA — 451 4.3.0) :
 * temporaire, ce n'est pas la faute du client.
 */
export const SMTP_REPLY_UNKNOWN_SERVER_ERROR: SmtpReply = {
  code: 451,
  enhancedStatus: '4.3.0',
  message: 'Erreur temporaire du service ; réessayez plus tard.',
};

/**
 * Traduit une exception de refus en réponse SMTP.
 *
 * 1. Si l'erreur porte un motif `SEND_REFUSAL` (`sendRefusalReason`, posé par
 *    `EmailsService.accept()`) : l'entrée correspondante de
 *    {@link SEND_REFUSAL_SMTP_REPLY}, exhaustive par construction.
 * 2. Sinon, repli du §4.4 : une `HttpException` 4xx inconnue →
 *    {@link SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL} (`550 5.7.1`) ; tout le reste
 *    (5xx, erreur qui n'est pas une `HttpException`) →
 *    {@link SMTP_REPLY_UNKNOWN_SERVER_ERROR} (`451 4.3.0`).
 *
 * Ne renvoie **jamais** `250` : chaque branche pointe sur une constante figée
 * dont le code est un refus (4xx/5xx) — un acceptation ne passe jamais par
 * cette fonction, elle vient de la valeur de retour de `accept()`, pas d'une
 * exception.
 */
export function smtpReplyForError(error: unknown): SmtpReply {
  const reason = sendRefusalReason(error);

  if (reason !== null) {
    return SEND_REFUSAL_SMTP_REPLY[reason];
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();

    if (status >= 400 && status < 500) {
      return SMTP_REPLY_UNKNOWN_CLIENT_REFUSAL;
    }
  }

  return SMTP_REPLY_UNKNOWN_SERVER_ERROR;
}
