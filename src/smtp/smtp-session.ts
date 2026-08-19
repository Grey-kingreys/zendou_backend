import type { SMTPServerSession } from 'smtp-server';
import type { AuthUser } from '../auth';

/**
 * Ce que le relais attache à la session une fois l'AUTH réussie. `smtp-server`
 * range dans `session.user` la valeur rendue par `onAuth`
 * (`lib/sasl.js:166` — `this.session.user = response.user`) et se contente d'en
 * vérifier la véracité ; le type publié par `@types/smtp-server`
 * (`user?: string`) décrit l'usage le plus courant, pas le contrat réel.
 *
 * Porter l'utilisateur complet — et non son seul identifiant — est ce qui
 * permettra à S7 d'appeler le point d'acceptation partagé sans relire la base
 * à chaque message, et ce qui rend possible la règle du §3.3 : un compte
 * **SUSPENDED authentifie normalement**, le refus tombant plus tard au
 * `MAIL FROM` avec le bon message. La suspension doit donc voyager dans la
 * session, pas bloquer l'AUTH.
 */
export interface SmtpSessionUser {
  /** `SmtpCredential.id` — alimentera `Email.smtpCredentialId` (§6, A15). */
  credentialId: string;
  /** Nom d'utilisateur en clair, pour la journalisation (jamais le secret). */
  username: string;
  /** Propriétaire de l'identifiant, dans la forme partagée avec l'API. */
  user: AuthUser;
}

/**
 * Lit l'utilisateur authentifié porté par une session `smtp-server`, ou `null`
 * si la connexion n'est pas authentifiée.
 *
 * `smtp-server` remet `session.user` à `false` hors authentification
 * (`lib/smtp-connection.js:1424,2094`), d'où le passage par un contrôle de
 * forme plutôt qu'un simple transtypage : c'est cette fonction qui porte
 * l'assertion explicite exigée au §5 (« pas d'open relay par construction »).
 */
export function smtpSessionUser(
  session: SMTPServerSession,
): SmtpSessionUser | null {
  const candidate: unknown = session.user;

  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as SmtpSessionUser).credentialId === 'string'
  ) {
    return candidate as SmtpSessionUser;
  }

  return null;
}
