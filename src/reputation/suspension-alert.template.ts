import {
  MAX_BOUNCE_RATE,
  MAX_COMPLAINT_RATE,
  REPUTATION_WINDOW_DAYS,
} from './reputation.constants';
import type { ReputationMetrics } from './reputation.types';

/**
 * Ce qu'il faut savoir pour composer l'alerte d'une suspension automatique
 * (E2).
 *
 * Volontairement plate et sans dépendance Nest : le gabarit est une fonction
 * pure, il se teste tel quel, et `ReputationService` n'a plus qu'à l'expédier.
 */
export interface SuspensionAlert {
  /** Adresse email du compte suspendu. */
  email: string;
  /** Identifiant interne du compte - celui de l'URL de la fiche admin. */
  userId: string;
  /**
   * Motif tel qu'il vient d'être inscrit dans `User.suspensionReason` : la
   * **même** phrase que l'écran admin affiche. Recomposer un texte différent
   * ici ferait diverger deux surfaces qui décrivent le même événement.
   */
  reason: string;
  /** Taux et volumes constatés sur la fenêtre d'observation. */
  metrics: ReputationMetrics;
  /** Lien direct vers la fiche du compte dans l'espace d'administration. */
  adminUrl: string;
}

/** Sujet et corps (texte + HTML) d'une alerte de suspension. */
export interface SuspensionAlertEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Compose l'alerte envoyée à l'administrateur à chaque suspension automatique.
 *
 * Le contenu est **actionnable** : qui est suspendu, pourquoi, sur quels
 * chiffres, et le lien qui mène directement à la fiche du compte. Celui qui
 * reçoit ce message doit pouvoir trancher - réactiver ou confirmer - sans
 * fouiller les journaux ni chercher l'identifiant du client.
 */
export function buildSuspensionAlertEmail(
  alert: SuspensionAlert,
): SuspensionAlertEmail {
  return {
    subject: `Suspension automatique du compte ${alert.email}`,
    text: buildText(alert),
    html: buildHtml(alert),
  };
}

/** La phrase qui dit ce qui vient de se passer, et pourquoi cela compte. */
const LEAD =
  "La surveillance de réputation vient de suspendre automatiquement un compte : ses envois sont coupés, effet immédiat. C'est la protection du compte SES de Zendou qui a joué - AWS mesure les taux de rebond et de plainte au niveau du compte entier, donc un seul client dégradé peut faire suspendre tout le service.";

/** Ce qu'il reste à faire, une fois le message lu. */
const NEXT_STEPS =
  "À vérifier : si le client est légitime (liste importée, campagne unique mal ciblée), sa réactivation depuis la fiche remet aussi sa fenêtre d'observation à zéro. Si les chiffres traduisent une vraie mauvaise pratique, laisser la suspension et prévenir le client.";

/** Les lignes de constat, identiques en texte et en HTML. */
function buildFacts(alert: SuspensionAlert): string[] {
  const { metrics } = alert;

  return [
    `Compte : ${alert.email} (${alert.userId})`,
    `Motif : ${alert.reason}`,
    `Envois sur la fenêtre : ${metrics.sent}`,
    `Rebonds durs : ${metrics.hardBounces} (${formatRate(metrics.bounceRate)}, seuil ${formatRate(MAX_BOUNCE_RATE)})`,
    `Rebonds transitoires, non sanctionnés : ${metrics.transientBounces}`,
    `Plaintes : ${metrics.complaints} (${formatRate(metrics.complaintRate)}, seuil ${formatRate(MAX_COMPLAINT_RATE)})`,
    `Fenêtre d'observation : ${REPUTATION_WINDOW_DAYS} jours au maximum`,
  ];
}

function buildText(alert: SuspensionAlert): string {
  return [
    LEAD,
    '',
    ...buildFacts(alert),
    '',
    'Fiche du compte :',
    alert.adminUrl,
    '',
    NEXT_STEPS,
    '',
    'Zendou, surveillance de la réputation',
  ].join('\n');
}

function buildHtml(alert: SuspensionAlert): string {
  const facts = buildFacts(alert)
    .map((fact) => `<li>${escapeHtml(fact)}</li>`)
    .join('');
  const url = escapeHtml(alert.adminUrl);

  return [
    '<!DOCTYPE html>',
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">',
    `<p>${escapeHtml(LEAD)}</p>`,
    `<ul>${facts}</ul>`,
    `<p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">Ouvrir la fiche du compte</a></p>`,
    `<p style="font-size:13px;color:#555555;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="word-break:break-all;">${url}</span></p>`,
    `<p>${escapeHtml(NEXT_STEPS)}</p>`,
    '<p style="font-size:13px;color:#555555;">Zendou, surveillance de la réputation</p>',
    '</body></html>',
  ].join('');
}

/** Taux en pourcentage, deux décimales - la forme des journaux et de la fiche. */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)} %`;
}

/**
 * Échappement HTML des valeurs interpolées. L'adresse du compte et le motif
 * viennent de la base, pas de nous : ils n'ont rien à faire en balisage brut
 * dans un email que nous signons en DKIM.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
