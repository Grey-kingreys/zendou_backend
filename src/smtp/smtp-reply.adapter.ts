import type { SmtpReply } from './smtp-reply';

/**
 * Adaptateur entre la forme `SmtpReply {code, enhancedStatus, message}` de S8
 * et la forme qu'attend réellement `smtp-server` — vérifiée contre la version
 * installée (3.19.3), pas supposée (hypothèse n°1, §2.1/§9 du plan B6).
 *
 * **Constat n°1 — le refus passe par `err.responseCode`.** Chaque point
 * d'accroche traite l'erreur rendue à son callback comme
 * `this.send(err.responseCode || <défaut>, err.message)` :
 * `lib/sasl.js:133,151` (AUTH, défaut 535), `lib/smtp-connection.js:411`
 * (onConnect, défaut 554), `:1767` (onMailFrom, défaut 550), `:1829`
 * (onRcptTo, défaut 550), `:1888` (onData, défaut 450). Une erreur sans
 * `responseCode` prendrait donc le défaut de l'étape — d'où cet adaptateur,
 * qui le pose systématiquement.
 *
 * **Constat n°2 — il n'existe aucun champ dédié au statut étendu.** Sur ces
 * chemins d'erreur, `send()` est appelée à **deux** arguments : le troisième
 * (`context`) n'est jamais transmis. La bibliothèque calcule alors elle-même
 * le statut étendu depuis sa propre table `ENHANCED_STATUS_CODES`
 * (`lib/smtp-connection.js:131-174`), que l'application ne peut pas influencer.
 * Cette table **contredit le §4.4 sur la majorité des lignes** : 550 → `5.1.1`
 * là où le §4.4 veut `5.7.1`, 538 → `5.7.0` contre `5.7.11`, 552 → `5.2.2`
 * contre `5.3.4`, 452 → `4.2.2` contre `4.5.3`, 501 → `5.5.4` contre `5.1.7`
 * et `5.1.3`, 450 → `4.2.1` contre `4.7.0`, 421 → `4.4.2` contre `4.7.0`.
 *
 * **Conséquence, et raison d'être de ce fichier :** le seul moyen de faire
 * parvenir au client les statuts étendus que le §4.4 spécifie est de les
 * écrire nous-mêmes en tête du texte de réponse — c'est la forme filaire
 * exacte de la RFC 3463 (`535 5.7.8 texte`) — **et** de neutraliser
 * l'injection automatique de la bibliothèque pour ne pas les voir apparaître
 * en double. La neutralisation se fait par l'option `hideENHANCEDSTATUSCODES`
 * (voir `smtp-server.service.ts`), que `smtp-server` positionne déjà à `true`
 * par défaut (`lib/smtp-server.js:50-52`) mais que nous fixons explicitement :
 * ce comportement est un défaut de la bibliothèque, pas un contrat, et s'il
 * changeait nos réponses deviendraient `550 5.1.1 5.7.1 …`.
 *
 * Le compromis assumé est que la capacité `ENHANCEDSTATUSCODES` n'est pas
 * annoncée dans l'EHLO (même option, `lib/smtp-connection.js:1179`). Il est
 * favorable : un client qui ne l'attend pas lit simplement `5.7.1` comme le
 * début du texte, sans rien casser, alors qu'un statut étendu **faux**
 * (`5.1.1` « boîte aux lettres inexistante » au lieu de `5.7.1` « envoi non
 * autorisé ») désinformerait activement le traitement des rebonds.
 */

/**
 * Marque posée sur les erreurs fabriquées par {@link smtpReplyToError}. Elle
 * distingue un **refus délibéré** — une réponse du §4.4, à transmettre telle
 * quelle au client — d'une **exception inattendue**, qui doit être journalisée
 * et transformée en `451 4.3.0` (contrepartie n°1 du §1.1). Un symbole plutôt
 * qu'un champ nommé : rien de ce qui traverse la frontière ne peut l'imiter
 * par accident.
 */
const SMTP_REPLY_ERROR_BRAND = Symbol('zendou.smtpReplyError');

/** Erreur de refus, dans la forme que `smtp-server` sait rendre au client. */
export interface SmtpReplyError extends Error {
  /** Code à trois chiffres lu par `smtp-server` (constat n°1 ci-dessus). */
  responseCode: number;
  /** Réponse d'origine, pour les assertions de test et la journalisation. */
  smtpReply: SmtpReply;
  [SMTP_REPLY_ERROR_BRAND]: true;
}

/**
 * Rend le texte filaire d'une réponse : statut étendu puis message, séparés
 * d'une espace (RFC 3463). C'est ce que `smtp-server` concatènera derrière le
 * code numérique — `535` + ` ` + `5.7.8 Authentification refusée : …`.
 */
export function formatSmtpReply(reply: SmtpReply): string {
  return `${reply.enhancedStatus} ${reply.message}`;
}

/**
 * Ligne de réponse complète telle qu'elle apparaîtra sur le socket. Sert aux
 * tests d'intégration, qui comparent la réponse réellement reçue par un client
 * SMTP réel à la constante S8 dont elle est censée provenir.
 */
export function formatSmtpReplyLine(reply: SmtpReply): string {
  return `${reply.code} ${formatSmtpReply(reply)}`;
}

/**
 * Transforme une réponse de refus en erreur transmissible à un callback
 * `smtp-server`. Aucun littéral de code n'est écrit ici : tout vient de la
 * constante `SmtpReply` passée en argument (S8 est la source unique).
 */
export function smtpReplyToError(reply: SmtpReply): SmtpReplyError {
  const error = new Error(formatSmtpReply(reply)) as SmtpReplyError;

  error.responseCode = reply.code;
  error.smtpReply = reply;
  error[SMTP_REPLY_ERROR_BRAND] = true;

  return error;
}

/** Vrai si l'erreur est un refus délibéré et non une exception inattendue. */
export function isSmtpReplyError(error: unknown): error is SmtpReplyError {
  return (
    error instanceof Error &&
    (error as Partial<SmtpReplyError>)[SMTP_REPLY_ERROR_BRAND] === true
  );
}
