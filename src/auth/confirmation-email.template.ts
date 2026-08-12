import { EMAIL_CONFIRMATION_TTL_HOURS } from './email-confirmation.constants';

/** Corps de l'email de confirmation, dans ses deux variantes. */
export interface ConfirmationEmailBody {
  html: string;
  text: string;
}

/**
 * Lien de confirmation.
 *
 * `base` vient de la configuration (`APP_BASE_URL`, à défaut
 * `FRONTEND_ORIGIN`) : aucune URL n'est écrite en dur, le passage à un domaine
 * Zendou est un changement de variable d'environnement. Le slash final
 * éventuel est retiré pour ne pas produire `https://zendou.dev//confirmation`.
 */
export function buildConfirmationUrl(base: string, token: string): string {
  return `${base.trim().replace(/\/+$/, '')}/confirmation?token=${encodeURIComponent(token)}`;
}

/**
 * Compose l'email de confirmation. Fonction pure : aucune dépendance Nest,
 * testable telle quelle.
 *
 * Les deux variantes (`html` et `text`) sont fournies systématiquement. Le
 * texte brut n'est pas une politesse : il fait passer le message chez les
 * clients de messagerie qui bloquent le HTML, et l'absence de variante texte
 * est un critère de score anti-spam — sur un compte SES partagé, chaque point
 * de réputation compte.
 */
export function buildConfirmationEmail(
  name: string,
  confirmationUrl: string,
): ConfirmationEmailBody {
  const greeting = name.trim() ? `Bonjour ${name.trim()},` : 'Bonjour,';

  const text = [
    greeting,
    '',
    "Bienvenue sur Zendou. Confirmez votre adresse email pour activer l'envoi",
    'et récupérer vos crédits de bienvenue :',
    '',
    confirmationUrl,
    '',
    `Ce lien est valable ${EMAIL_CONFIRMATION_TTL_HOURS} heures. Passé ce délai, demandez-en un nouveau`,
    'depuis votre tableau de bord.',
    '',
    "Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message :",
    'aucun compte ne sera activé sans cette confirmation.',
    '',
    '— L’équipe Zendou',
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">',
    `<p>${escapeHtml(greeting)}</p>`,
    "<p>Bienvenue sur Zendou. Confirmez votre adresse email pour activer l'envoi et récupérer vos crédits de bienvenue.</p>",
    `<p><a href="${escapeHtml(confirmationUrl)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">Confirmer mon adresse</a></p>`,
    `<p style="font-size:13px;color:#555555;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;">${escapeHtml(confirmationUrl)}</span></p>`,
    `<p style="font-size:13px;color:#555555;">Ce lien est valable ${EMAIL_CONFIRMATION_TTL_HOURS} heures. Passé ce délai, demandez-en un nouveau depuis votre tableau de bord.</p>`,
    '<p style="font-size:13px;color:#555555;">Si vous n\'êtes pas à l\'origine de cette inscription, ignorez ce message : aucun compte ne sera activé sans cette confirmation.</p>',
    '<p style="font-size:13px;color:#555555;">— L’équipe Zendou</p>',
    '</body></html>',
  ].join('');

  return { html, text };
}

/**
 * Échappement HTML des valeurs interpolées. Le nom vient de l'utilisateur :
 * sans cela, un nom contenant `<` ou `"` casserait le document — voire
 * injecterait du balisage dans un email que nous signons en DKIM.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
