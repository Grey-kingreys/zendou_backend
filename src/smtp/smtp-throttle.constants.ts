import type { SmtpReply } from './smtp-reply';

/**
 * Constantes de l'anti-abus SMTP (B6/S9) qui dépendent du type `SmtpReply`.
 *
 * Pourquoi un fichier séparé de `smtp-relay.constants.ts` : celui-ci est
 * importé par `config/env.schema.ts`, et doit donc rester sans dépendance.
 * L'import de type ci-dessus est effacé à la compilation, mais les **valeurs**
 * exportées plus bas tireraient `smtp-reply.ts` — donc `emails.service.ts` —
 * dans la validation d'environnement si elles vivaient là-bas. Défauts
 * numériques d'un côté, réponses de refus de l'autre.
 *
 * ⚠️ Les quatre réponses ci-dessous **complètent** `smtp-reply.ts` (S8, propriété
 * exclusive de cette tâche-là) : ce sont des lignes du §4.4 que la table des
 * motifs `SEND_REFUSAL` ne couvre pas, parce qu'elles ne passent jamais par
 * `EmailsService.accept()` — l'anti-abus refuse **avant** le point
 * d'acceptation, parfois avant même l'authentification. Elles suivent la même
 * discipline : aucun littéral de code n'est écrit ailleurs que dans une
 * constante `SmtpReply`.
 */

/** Token d'injection du client Redis dédié aux compteurs anti-abus SMTP. */
export const SMTP_THROTTLE_REDIS = 'SMTP_THROTTLE_REDIS';

/**
 * Préfixe de **toutes** les clés Redis de l'anti-abus SMTP.
 *
 * Distinct de `RATE_LIMIT_KEY_PREFIX` (`throttle:`) et ce n'est pas
 * cosmétique : les deux familles de compteurs vivent sur le **même** Redis
 * (§5), avec des fenêtres, des limites et des identités différentes. Un préfixe
 * partagé ferait qu'un envoi SMTP consommerait le budget HTTP de la même
 * identité — deux canaux, un seul robinet.
 */
export const SMTP_THROTTLE_KEY_PREFIX = 'smtp:';

/**
 * §4.4 « Trop d'échecs AUTH sur la connexion » — AUTH — `421 4.7.0` +
 * fermeture. `smtp-server` ferme de lui-même le socket sur tout `421`
 * (`lib/smtp-connection.js:553-556`) : le code **est** la fermeture, il n'y a
 * rien à ajouter côté application.
 */
export const SMTP_REPLY_TOO_MANY_AUTH_FAILURES: SmtpReply = {
  code: 421,
  enhancedStatus: '4.7.0',
  message: 'Trop d’échecs d’authentification ; connexion fermée.',
};

/**
 * §4.4 « Rafale (messages/minute) » — MAIL FROM — `451 4.7.0`, équivalent SMTP
 * du 429 HTTP. **Temporaire** à dessein : le MTA du client patiente et
 * relivre ; un 5xx ferait rebondir des messages parfaitement légitimes qui
 * n'avaient que le tort d'arriver groupés.
 *
 * Le texte est celui du 429 de l'API (`TOO_MANY_REQUESTS_MESSAGE`) — même
 * situation, même phrase : c'est une seule limite produit vue de deux canaux.
 */
export const SMTP_REPLY_SEND_RATE_EXCEEDED: SmtpReply = {
  code: 451,
  enhancedStatus: '4.7.0',
  message: 'Trop de messages en peu de temps ; réessayez dans un instant.',
};

/**
 * §5 « Par connexion : plafond de messages (défaut 100) » — MAIL FROM —
 * `421 4.7.0` + fermeture. Fermer plutôt que refuser message par message est
 * délibéré : la connexion a fait son quota, la rouvrir coûte au client une
 * poignée de main et rend la conversation lisible dans les journaux.
 */
export const SMTP_REPLY_TOO_MANY_MESSAGES: SmtpReply = {
  code: 421,
  enhancedStatus: '4.7.0',
  message: 'Trop de messages sur cette connexion ; reconnectez-vous.',
};

/**
 * §5 « plafond de `RCPT` refusés » — RCPT TO — `421 4.7.0` + fermeture.
 * Anti-moissonnage d'adresses : présenter des destinataires pour lire lesquels
 * sont acceptés est la façon classique de construire un annuaire. Le texte ne
 * dit pas *pourquoi* les destinataires ont été refusés — ce serait redonner
 * l'information qu'on vient de couper.
 */
export const SMTP_REPLY_TOO_MANY_REFUSED_RECIPIENTS: SmtpReply = {
  code: 421,
  enhancedStatus: '4.7.0',
  message: 'Trop de destinataires refusés sur cette connexion.',
};
