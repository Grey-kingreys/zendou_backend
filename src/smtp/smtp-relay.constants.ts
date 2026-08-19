/**
 * Valeurs par défaut et messages de configuration du relais SMTP (B6/S5).
 *
 * Ce fichier ne dépend de rien : il est importé aussi bien par
 * `config/env.schema.ts` (pour les défauts et les messages de `refine`) que
 * par le module de relais lui-même, exactement comme
 * `rate-limit.constants.ts` l'est déjà pour les limites de débit.
 */

/**
 * Ports écoutés par défaut en mode STARTTLS (§1.2 du plan B6) : **587**
 * (obligatoire — défaut de WP Mail SMTP, PHPMailer, Laravel, Django, Rails,
 * Nodemailer) et **2525** (alias de repli, coût nul, utile en Guinée si un FAI
 * filtre 587). Le port 25 n'y figure pas et n'y figurera jamais (A6) : c'est
 * du transit MX, pas de la soumission.
 */
export const SMTP_DEFAULT_PORTS_STARTTLS = '587,2525';

/**
 * Port écouté par défaut en TLS implicite (§1.2) : **465**, préféré par la
 * RFC 8314 et imposé par beaucoup d'hébergeurs PHP mutualisés
 * (`SMTPSecure = 'ssl'`).
 */
export const SMTP_DEFAULT_PORTS_TLS = '465';

/**
 * Interface d'écoute par défaut : toutes. Sous Dokploy le port est publié en
 * `mode: host` (A18), c'est Docker qui restreint l'exposition — pas nous. La
 * variable existe pour les déploiements qui veulent lier une interface
 * précise, et pour que les tests d'intégration n'écoutent que sur la boucle
 * locale.
 */
export const SMTP_DEFAULT_BIND_ADDRESS = '0.0.0.0';

/**
 * Connexions simultanées acceptées par instance `SMTPServer`. Première ligne
 * de défense du §5 : elle plafonne l'event loop partagé avec l'API (§1.1 —
 * même processus). Le plafond **par IP** (compteur Redis) est le travail de
 * S9 ; celui-ci est global et local à l'instance.
 */
export const SMTP_DEFAULT_MAX_CLIENTS = 50;

/**
 * Inactivité tolérée sur une connexion avant fermeture (§5, « connexions qui
 * traînent »). Une minute : large pour l'envoi d'un message de plusieurs Mo
 * sur un réseau guinéen, court pour un socket abandonné.
 */
export const SMTP_DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

/**
 * Délai laissé aux connexions en cours lors d'un arrêt gracieux avant qu'elles
 * ne reçoivent `421` et soient fermées. Volontairement plus court que les 30 s
 * par défaut de `smtp-server` : Dokploy laisse un temps limité entre SIGTERM
 * et SIGKILL, et un arrêt qui traîne finit en arrêt brutal.
 */
export const SMTP_DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

/**
 * Fenêtre d'apaisement avant de relire les fichiers de certificat après un
 * événement `fs.watch`. `certbot` réécrit clé **et** certificat : sans
 * temporisation on relirait un couple incohérent (nouvelle clé, ancien
 * certificat) au milieu du renouvellement.
 */
export const SMTP_TLS_RELOAD_DEBOUNCE_MS = 500;

/**
 * Message du `refine` d'`env.schema.ts` : en production, un relais activé sans
 * certificat ne démarre pas (§1.4, règle dure et testable — A19).
 */
export const SMTP_TLS_CERTIFICATE_REQUIRED_MESSAGE =
  'SMTP_TLS_CERT_PATH et SMTP_TLS_KEY_PATH sont obligatoires quand NODE_ENV=production et SMTP_RELAY_ENABLED=true : un serveur de soumission SMTP ne démarre jamais en clair.';

/**
 * Message du `refine` d'`env.schema.ts` : un relais activé qui n'écoute nulle
 * part serait un service silencieusement mort — précisément l'état que le §6
 * (A16) désigne comme le pire de tous.
 */
export const SMTP_NO_LISTENING_PORT_MESSAGE =
  'au moins un port doit rester écouté quand SMTP_RELAY_ENABLED=true : SMTP_PORTS_STARTTLS et SMTP_PORTS_TLS sont toutes les deux vides, le relais serait activé sans aucune écoute.';
