import { SMTP_CERT_ALERT_THRESHOLDS_DAYS } from './smtp-cert-alert.constants';
import type { SmtpCertificateSnapshot } from './smtp-cert-alert.inspector';

/**
 * Les trois situations qui déclenchent une alerte (B6/H1).
 *
 * Union discriminée plutôt qu'un objet à champs optionnels : le rendu de
 * l'email doit être exhaustif, et le compilateur doit le dire si un cas
 * s'ajoute un jour.
 */
export type SmtpCertAlert =
  /** Palier franchi : il reste `daysRemaining` jours avant l'échéance. */
  | {
      kind: 'threshold';
      snapshot: SmtpCertificateSnapshot;
      daysRemaining: number;
      threshold: number;
    }
  /** Certificat déjà expiré depuis `daysExpired` jours (0 = aujourd'hui). */
  | {
      kind: 'expired';
      snapshot: SmtpCertificateSnapshot;
      daysExpired: number;
    }
  /** Fichier absent, illisible ou non analysable — incident, pas prévision. */
  | {
      kind: 'unreadable';
      certPath: string;
      detail: string;
    };

/** Sujet et corps (HTML + texte) d'une alerte. */
export interface SmtpCertAlertEmail {
  subject: string;
  html: string;
  text: string;
}

/** Domaine affiché quand le certificat n'a pas pu être lu. */
const UNKNOWN_DOMAIN = 'smtp.votre-domaine.gn';

/**
 * Zone Cloudflare qui héberge les enregistrements DNS de Zendou. C'est sur
 * elle que le jeton d'API utilisé par le défi DNS-01 doit porter.
 */
const CLOUDFLARE_ZONE = 'zendou.app';

/**
 * Phrase qui débloque le porteur, et la raison d'être de tout le reste.
 *
 * Le porteur n'a **ni accès SSH ni root** à la machine qui héberge le relais :
 * elle est administrée par un tiers, lui n'a qu'un compte Dokploy. Une marche
 * à suivre qui commencerait par « connectez-vous au serveur » le bloquerait au
 * moment précis où il doit agir vite. Or elle n'a pas lieu d'être : le défi
 * DNS-01 s'adresse uniquement à l'API Cloudflare — il prouve la maîtrise de la
 * zone, pas celle du serveur — et se déroule donc entièrement depuis le poste
 * du porteur. C'est ce qui rend ce renouvellement possible sans la machine, et
 * c'est pourquoi cette information vient **avant** la première commande.
 */
const NO_SERVER_ACCESS_NEEDED =
  "Aucun accès au serveur n'est nécessaire : le défi DNS-01 ne s'adresse qu'à l'API Cloudflare, jamais à la machine qui héberge le relais. La commande ci-dessous tourne donc depuis n'importe quel poste — votre Mac, par exemple. Tout le reste se passe dans Dokploy.";

/** Mois en français — formatage déterministe, sans dépendance à l'ICU. */
const MONTHS_FR = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

/**
 * Date d'échéance en clair, en UTC : « 5 septembre 2026 à 15:46 UTC ».
 *
 * Formatage écrit à la main plutôt qu'`Intl.DateTimeFormat` : le rendu ne doit
 * dépendre ni du fuseau de la machine, ni de la présence d'un ICU complet dans
 * l'image Docker. Un email d'alerte qui affiche une heure locale fantaisiste
 * selon le serveur serait pire qu'inutile.
 */
export function formatCertificateExpiry(date: Date): string {
  const day = date.getUTCDate();
  const month = MONTHS_FR[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${day} ${month} ${year} à ${hours}:${minutes} UTC`;
}

/** « 1 jour » / « 7 jours » — l'accord se voit dans un objet d'email. */
function pluralizeDays(days: number): string {
  return days > 1 ? `${days} jours` : `${days} jour`;
}

/**
 * Compose l'email d'alerte. Fonction pure, aucune dépendance Nest : elle se
 * teste telle quelle, et le service n'a plus qu'à l'expédier.
 *
 * Le contenu est **actionnable** : domaine, échéance, jours restants, puis les
 * commandes exactes de renouvellement. Le porteur qui reçoit ce message doit
 * pouvoir agir sans rouvrir la documentation ni chercher le nom du domaine.
 */
export function buildSmtpCertAlertEmail(
  alert: SmtpCertAlert,
): SmtpCertAlertEmail {
  const domain =
    alert.kind === 'unreadable' ? UNKNOWN_DOMAIN : alert.snapshot.subjectName;

  return {
    subject: buildSubject(alert),
    text: buildText(alert, domain),
    html: buildHtml(alert, domain),
  };
}

function buildSubject(alert: SmtpCertAlert): string {
  switch (alert.kind) {
    case 'threshold':
      return alert.daysRemaining <= 0
        ? "Certificat SMTP : expire aujourd'hui"
        : `Certificat SMTP : expire dans ${pluralizeDays(alert.daysRemaining)}`;
    case 'expired':
      return alert.daysExpired <= 0
        ? "Certificat SMTP : EXPIRÉ aujourd'hui"
        : `Certificat SMTP : EXPIRÉ depuis ${pluralizeDays(alert.daysExpired)}`;
    case 'unreadable':
      return 'Certificat SMTP : fichier introuvable ou illisible';
  }
}

/** Les trois ou quatre lignes qui décrivent la situation constatée. */
function buildFacts(alert: SmtpCertAlert, domain: string): string[] {
  switch (alert.kind) {
    case 'threshold':
      return [
        `Domaine : ${domain}`,
        `Expiration : ${formatCertificateExpiry(alert.snapshot.expiresAt)}`,
        `Jours restants : ${alert.daysRemaining}`,
      ];
    case 'expired':
      return [
        `Domaine : ${domain}`,
        `Expiration : ${formatCertificateExpiry(alert.snapshot.expiresAt)}`,
        `Jours restants : 0 — le certificat est EXPIRÉ depuis ${pluralizeDays(Math.max(alert.daysExpired, 1))}`,
      ];
    case 'unreadable':
      return [
        `Fichier attendu : ${alert.certPath} (SMTP_TLS_CERT_PATH)`,
        `Erreur : ${alert.detail}`,
      ];
  }
}

/** La phrase qui dit pourquoi ce message arrive maintenant. */
function buildLead(alert: SmtpCertAlert): string {
  switch (alert.kind) {
    case 'threshold':
      return "Le certificat TLS du relais SMTP de Zendou approche de son échéance. Son renouvellement est manuel : sans intervention, tous les clients SMTP (WordPress, ERP, CRM…) cesseront de pouvoir se connecter, sans message d'erreur côté Zendou.";
    case 'expired':
      return 'Le certificat TLS du relais SMTP de Zendou est EXPIRÉ. Les clients SMTP ne peuvent plus établir de session TLS : les envois par ce canal sont interrompus. Le renouvellement ci-dessous est à effectuer immédiatement.';
    case 'unreadable':
      return "Le certificat TLS du relais SMTP de Zendou est introuvable ou illisible. C'est au moins aussi grave qu'une expiration : au prochain redéploiement, le relais refuserait de démarrer (un serveur de soumission ne démarre jamais en clair).";
  }
}

function buildText(alert: SmtpCertAlert, domain: string): string {
  return [
    buildLead(alert),
    '',
    ...buildFacts(alert, domain),
    '',
    NO_SERVER_ACCESS_NEEDED,
    '',
    'Marche à suivre :',
    '',
    '1) Renouveler le certificat avec certbot (défi DNS-01 Cloudflare). Le',
    `   fichier d'identifiants porte un jeton d'API Cloudflare au périmètre`,
    `   « Zone → DNS → Edit » sur ${CLOUDFLARE_ZONE} ; son emplacement dépend du`,
    '   poste depuis lequel vous lancez la commande :',
    '',
    ...renewalCommand(domain).map((line) => `   ${line}`),
    '',
    '2) Afficher le nouveau couple certificat / clé privée. certbot indique',
    `   les chemins exacts en fin d'exécution ; par défaut :`,
    '',
    `   cat /etc/letsencrypt/live/${domain}/fullchain.pem`,
    `   cat /etc/letsencrypt/live/${domain}/privkey.pem`,
    '',
    "3) Dans Dokploy, ouvrir l'application backend Zendou, onglet « Advanced »",
    '   puis « File Mounts » : remplacer le contenu des deux fichiers montés',
    '   (SMTP_TLS_CERT_PATH et SMTP_TLS_KEY_PATH) par les blocs affichés',
    "   ci-dessus, en gardant les lignes BEGIN/END et l'indentation nulle.",
    '',
    '4) Redéployer (bouton « Deploy »). Le relais relit le couple TLS au',
    '   démarrage : aucune autre action nécessaire.',
    '',
    '5) Vérifier depuis un poste quelconque :',
    '',
    `   openssl s_client -connect ${domain}:465 </dev/null 2>/dev/null \\`,
    '     | openssl x509 -noout -subject -enddate',
    '',
    `Cette alerte n'est envoyée qu'une fois par palier franchi (${SMTP_CERT_ALERT_THRESHOLDS_DAYS.join(', ')} jours,`,
    'puis expiration) et par certificat : le renouvellement la réarme de',
    'lui-même, aucune action à faire pour la faire taire.',
    '',
    '— Zendou, surveillance du relais SMTP',
  ].join('\n');
}

function buildHtml(alert: SmtpCertAlert, domain: string): string {
  const facts = buildFacts(alert, domain)
    .map((fact) => `<li>${escapeHtml(fact)}</li>`)
    .join('');

  const renewal = escapeHtml(renewalCommand(domain).join('\n'));

  return [
    '<!DOCTYPE html>',
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;">',
    `<p>${escapeHtml(buildLead(alert))}</p>`,
    `<ul>${facts}</ul>`,
    `<p>${escapeHtml(NO_SERVER_ACCESS_NEEDED)}</p>`,
    '<p><strong>Marche à suivre :</strong></p>',
    `<p>1) Renouveler le certificat avec certbot (défi DNS-01 Cloudflare). Le fichier d'identifiants porte un jeton d'API Cloudflare au périmètre « Zone → DNS → Edit » sur ${CLOUDFLARE_ZONE} ; son emplacement dépend du poste depuis lequel vous lancez la commande :</p>`,
    `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;">${renewal}</pre>`,
    `<p>2) Afficher le nouveau couple certificat / clé privée. certbot indique les chemins exacts en fin d'exécution ; par défaut :</p>`,
    `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(`cat /etc/letsencrypt/live/${domain}/fullchain.pem\ncat /etc/letsencrypt/live/${domain}/privkey.pem`)}</pre>`,
    "<p>3) Dans Dokploy, ouvrir l'application backend Zendou, onglet « Advanced » puis « File Mounts » : remplacer le contenu des deux fichiers montés (SMTP_TLS_CERT_PATH et SMTP_TLS_KEY_PATH) par les blocs affichés ci-dessus, en gardant les lignes BEGIN/END.</p>",
    '<p>4) Redéployer (bouton « Deploy »). Le relais relit le couple TLS au démarrage.</p>',
    '<p>5) Vérifier depuis un poste quelconque :</p>',
    `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(`openssl s_client -connect ${domain}:465 </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate`)}</pre>`,
    `<p style="font-size:13px;color:#555555;">Cette alerte n'est envoyée qu'une fois par palier franchi (${SMTP_CERT_ALERT_THRESHOLDS_DAYS.join(', ')} jours, puis expiration) et par certificat : le renouvellement la réarme de lui-même.</p>`,
    '<p style="font-size:13px;color:#555555;">— Zendou, surveillance du relais SMTP</p>',
    '</body></html>',
  ].join('');
}

/**
 * Commande de renouvellement, telle qu'elle doit être tapée.
 *
 * DNS-01 Cloudflare et non HTTP-01, pour une raison qui prime sur toutes les
 * autres : HTTP-01 exigerait de servir un fichier depuis la machine du relais,
 * à laquelle le porteur n'a pas accès. DNS-01 ne demande que la maîtrise de la
 * zone, qu'il a. (S'y ajoutent deux raisons secondaires : le port 80 est déjà
 * pris par Traefik, et le relais SMTP n'a aucun serveur web à lui.)
 *
 * Le chemin du fichier d'identifiants est un **repère à compléter**, pas une
 * valeur : il dépend du poste depuis lequel la commande est lancée, et écrire
 * un chemin absolu vraisemblable ferait croire qu'il existe déjà.
 */
function renewalCommand(domain: string): string[] {
  return [
    'certbot certonly \\',
    '  --dns-cloudflare \\',
    '  --dns-cloudflare-credentials <chemin-vers>/credentials.ini \\',
    '  --dns-cloudflare-propagation-seconds 60 \\',
    `  -d ${domain} \\`,
    '  --non-interactive --agree-tos',
  ];
}

/**
 * Échappement HTML des valeurs interpolées. Le nom du domaine et le message
 * d'erreur viennent du certificat et du système de fichiers, pas de nous : ils
 * n'ont rien à faire en balisage brut dans un email que nous signons en DKIM.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
