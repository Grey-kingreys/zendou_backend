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

// ───────────────────────────────────────────────────────────────────────────
// Anti-abus SMTP (B6/S9 — §5 du plan)
//
// Les défauts vivent ici, aux côtés de ceux de S5, parce que ce fichier est
// celui qu'`env.schema.ts` importe : il ne doit dépendre de rien. Les
// constantes de S9 qui, elles, dépendent du type `SmtpReply` (les réponses de
// refus) vivent dans `smtp-throttle.constants.ts` — les faire remonter ici
// tirerait toute la chaîne `smtp-reply.ts` → `emails.service.ts` dans la
// validation d'environnement.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Connexions acceptées depuis une même IP pendant
 * {@link SMTP_DEFAULT_CONNECTION_WINDOW_MS}. Complète — sans le remplacer — le
 * `maxClients` de S5 : celui-ci borne la simultanéité **toutes IP confondues**
 * et protège l'event loop, celui-là empêche **une seule** source de consommer
 * tout le budget.
 *
 * 30 par minute : un client SMTP normal ouvre une connexion et y enchaîne ses
 * messages ; même un WordPress bavard qui rouvre à chaque email reste très en
 * dessous. Un balayage, lui, ouvre des dizaines de connexions par seconde.
 */
export const SMTP_DEFAULT_MAX_CONNECTIONS_PER_IP = 30;

/** Fenêtre du compteur de connexions par IP. Une minute. */
export const SMTP_DEFAULT_CONNECTION_WINDOW_MS = 60_000;

/**
 * Échecs d'authentification **tolérés sur une même connexion**. Le suivant —
 * le N+1ᵉ — reçoit `421` et voit son socket fermé (§4.4).
 *
 * 3 : un client mal configuré se trompe une fois et rejoue ; un attaquant, lui,
 * veut enchaîner des milliers de couples sur une connexion ouverte. Fermer
 * n'interdit rien (il peut rouvrir) mais lui impose le coût d'une poignée de
 * main TCP + TLS par groupe de trois essais, ce qui suffit à rendre le
 * bourrinage inintéressant. Le vrai plafond global reste le compteur de
 * connexions par IP ci-dessus.
 */
export const SMTP_DEFAULT_MAX_AUTH_FAILURES_PER_CONNECTION = 3;

/**
 * Fenêtre des compteurs Redis d'échecs d'AUTH (par IP et par nom
 * d'utilisateur). Quinze minutes : assez long pour qu'une campagne lente reste
 * visible d'un échec au suivant, assez court pour qu'un client qui a corrigé sa
 * configuration reparte d'une ardoise propre.
 */
export const SMTP_DEFAULT_AUTH_FAILURE_WINDOW_MS = 900_000;

/**
 * Nombre de **noms d'utilisateur distincts** sur lesquels une même IP doit
 * échouer, dans la fenêtre ci-dessus, pour déclencher la ligne de journal
 * d'alerte du §5. C'est la signature du bourrinage d'identifiants : se tromper
 * de mot de passe sur *son* identifiant est banal, se tromper sur trois
 * identifiants différents ne l'est pas.
 *
 * Cette alerte **ne bloque rien** : les noms d'utilisateur étant opaques et
 * aléatoires (`zdu_` + 16 hex, §3.2), ils ne sont pas énumérables, et
 * verrouiller un compte sur des échecs offrirait un déni de service à qui en
 * connaîtrait un seul (§5). Elle informe l'exploitation, rien de plus.
 */
export const SMTP_DEFAULT_AUTH_STUFFING_USERNAME_THRESHOLD = 3;

/**
 * Messages acceptés sur **une même connexion** avant refus (§5, « plafond de
 * messages par connexion »). Défaut 100, valeur donnée par le plan.
 */
export const SMTP_DEFAULT_MAX_MESSAGES_PER_CONNECTION = 100;

/**
 * Destinataires **refusés** tolérés sur une même connexion (§5, « plafond de
 * `RCPT` refusés »). Au-delà : `421` + fermeture.
 *
 * C'est la protection anti-moissonnage : un annuaire se construit en présentant
 * des adresses et en lisant lesquelles sont acceptées. Dix refus sur une seule
 * connexion ne correspondent à aucun usage légitime — un client normal envoie à
 * des adresses qu'il connaît déjà.
 */
export const SMTP_DEFAULT_MAX_REFUSED_RECIPIENTS_PER_CONNECTION = 10;

/**
 * Message d'avertissement émis au démarrage quand `SMTP_IP_LIMITS_ENABLED` est
 * faux (§5, dernier point ⚠️ + le piège Swarm du §1.3).
 *
 * Sous Docker Swarm en mode `ingress`, le *routing mesh* réécrit l'IP source :
 * toutes les connexions arrivent avec celle de la passerelle. Une limite par IP
 * deviendrait alors **un compteur unique partagé par toute la planète** — le
 * premier client à saturer ferait taire tous les autres. « Une limite qui
 * compte tout le monde ensemble est pire qu'une limite absente » : on la coupe
 * donc franchement, et on le dit fort, plutôt que de la laisser à faux.
 */
export const SMTP_IP_LIMITS_DISABLED_MESSAGE =
  'IP source non fiable : limites par IP désactivées (SMTP_IP_LIMITS_ENABLED=false). Les limites par utilisateur restent actives ; vérifiez la publication des ports en mode host si ce n’est pas voulu.';
