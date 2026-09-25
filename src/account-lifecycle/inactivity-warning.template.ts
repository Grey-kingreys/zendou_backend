import {
  INACTIVITY_ANONYMIZE_AFTER_MONTHS,
  INACTIVITY_WARNING_SUBJECT_PREFIX,
} from './account-lifecycle.constants';

/** Sujet et corps (HTML + texte) de l'avertissement d'inactivité. */
export interface InactivityWarningEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Date lisible en français, sans heure. Fuseau UTC : c'est celui de la
 * Guinée (GMT, sans heure d'été), et celui dans lequel le traitement calcule.
 */
export function formatFrenchDate(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Compose l'avertissement envoyé à un compte inactif (ANON-1). Il dit ce qui
 * va se passer, à quelle date, et qu'une simple connexion suffit à l'éviter.
 * Fonction pure, testable telle quelle.
 */
export function buildInactivityWarningEmail(input: {
  name: string;
  anonymizationDate: Date;
  loginUrl: string;
}): InactivityWarningEmail {
  const date = formatFrenchDate(input.anonymizationDate);
  const greeting = input.name.trim()
    ? `Bonjour ${input.name.trim()},`
    : 'Bonjour,';

  const whatHappens =
    'Votre nom, votre adresse email, votre société, vos domaines, vos clés API, vos identifiants SMTP et votre journal d’envois seront effacés, et le compte ne pourra plus être utilisé.';
  const whatStays =
    'Seules les traces de paiement (recharges et mouvements de crédits) sont conservées, pour la comptabilité.';
  const howToAvoid =
    'Pour garder votre compte, il suffit de vous connecter avant cette date (par mot de passe ou avec Google). Aucune autre démarche n’est nécessaire.';

  const text = [
    greeting,
    '',
    `Votre compte Zendou n’a connu aucune activité (ni connexion, ni envoi) depuis près de ${INACTIVITY_ANONYMIZE_AFTER_MONTHS} mois.`,
    `Comme l’annonce notre politique de confidentialité, il sera anonymisé le ${date}.`,
    '',
    whatHappens,
    whatStays,
    '',
    howToAvoid,
    '',
    input.loginUrl,
    '',
    'L’équipe Zendou',
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">',
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>Votre compte Zendou n’a connu aucune activité (ni connexion, ni envoi) depuis près de ${INACTIVITY_ANONYMIZE_AFTER_MONTHS} mois. Comme l’annonce notre politique de confidentialité, il sera anonymisé le <strong>${escapeHtml(date)}</strong>.</p>`,
    `<p>${escapeHtml(whatHappens)} ${escapeHtml(whatStays)}</p>`,
    `<p>${escapeHtml(howToAvoid)}</p>`,
    `<p><a href="${escapeHtml(input.loginUrl)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">Me connecter</a></p>`,
    `<p style="font-size:13px;color:#555555;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;">${escapeHtml(input.loginUrl)}</span></p>`,
    '<p style="font-size:13px;color:#555555;">L’équipe Zendou</p>',
    '</body></html>',
  ].join('');

  return {
    subject: `${INACTIVITY_WARNING_SUBJECT_PREFIX}${date}`,
    html,
    text,
  };
}

/** Lien de connexion : base de l'application, sans slash final. */
export function buildLoginUrl(base: string): string {
  return `${base.trim().replace(/\/+$/, '')}/connexion`;
}

/** Échappement HTML des valeurs interpolées (le nom vient de l'utilisateur). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
