/** Sujet et corps (HTML + texte) de l'alerte de solde bas. */
export interface LowBalanceAlertEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Compose l'alerte de solde bas : le solde restant, ce qui se passe à 0, et le
 * lien vers l'écran de facturation. Fonction pure, testable telle quelle.
 */
export function buildLowBalanceAlertEmail(input: {
  name: string;
  balance: number;
  billingUrl: string;
}): LowBalanceAlertEmail {
  const greeting = input.name.trim()
    ? `Bonjour ${input.name.trim()},`
    : 'Bonjour,';
  const remaining = `Il vous reste ${input.balance} ${input.balance > 1 ? 'crédits' : 'crédit'} sur votre compte Zendou.`;
  const consequence =
    'Chaque email envoyé consomme un crédit. Quand le solde atteindra 0, vos envois s’arrêteront : l’API répondra par une erreur 402 (crédits insuffisants) et le relais SMTP refusera les messages, jusqu’à une nouvelle recharge.';
  const action =
    'Pour éviter toute interruption, rechargez votre compte dès maintenant.';

  const text = [
    greeting,
    '',
    remaining,
    consequence,
    '',
    action,
    '',
    input.billingUrl,
    '',
    'L’équipe Zendou',
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">',
    `<p>${escapeHtml(greeting)}</p>`,
    `<p><strong>${escapeHtml(remaining)}</strong></p>`,
    `<p>${escapeHtml(consequence)}</p>`,
    `<p>${escapeHtml(action)}</p>`,
    `<p><a href="${escapeHtml(input.billingUrl)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">Recharger mon compte</a></p>`,
    `<p style="font-size:13px;color:#555555;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;">${escapeHtml(input.billingUrl)}</span></p>`,
    '<p style="font-size:13px;color:#555555;">L’équipe Zendou</p>',
    '</body></html>',
  ].join('');

  return {
    subject: 'Votre solde de crédits Zendou est bas',
    html,
    text,
  };
}

/** Lien de l'écran de facturation : base de l'application, sans slash final. */
export function buildBillingUrl(base: string): string {
  return `${base.trim().replace(/\/+$/, '')}/dashboard/facturation`;
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
