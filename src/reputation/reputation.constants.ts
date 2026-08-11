import { EmailStatus } from '@prisma/client';

/**
 * Seuils de réputation d'envoi.
 *
 * Enjeu : AWS SES surveille les taux de rebond et de plainte au niveau du
 * **compte entier**. Un seul client abusif peut donc faire suspendre le
 * compte SES de Zendou, et couper tous les autres clients. Nos seuils sont
 * volontairement plus stricts que ceux d'AWS (5 % de rebonds et 0,1 % de
 * plaintes déclenchent une revue chez AWS) : on suspend le client avant
 * qu'AWS ne nous suspende.
 */

/** Fenêtre glissante d'observation des taux. */
export const REPUTATION_WINDOW_DAYS = 30;

/**
 * Statuts comptés comme « envoi réellement parti » : le message a quitté
 * Zendou pour SES. `QUEUED`, `REJECTED`, `FAILED` et `SUPPRESSED` ne sont
 * pas des envois et ne doivent pas diluer les taux.
 */
export const SENT_EMAIL_STATUSES = [
  EmailStatus.SENT,
  EmailStatus.DELIVERED,
  EmailStatus.BOUNCED,
  EmailStatus.COMPLAINED,
] as const;

/**
 * Volume minimum avant toute sanction. Sans ce garde-fou, un client tout
 * neuf avec 1 rebond sur 3 envois afficherait 33 % de rebonds et serait
 * suspendu à tort : sous ce volume, les taux ne sont pas significatifs.
 */
export const MIN_VOLUME_FOR_SANCTION = 50;

/** Taux de rebond maximum toléré : au-delà, suspension. */
export const MAX_BOUNCE_RATE = 0.05;

/** Taux de plainte maximum toléré : au-delà, suspension. */
export const MAX_COMPLAINT_RATE = 0.001;

/**
 * Fraction du seuil à partir de laquelle on alerte sans sanctionner :
 * le client (et nous) voit venir la suspension avant de la subir.
 */
export const WARNING_THRESHOLD_RATIO = 0.6;

/** Limite journalière d'un compte neuf (miroir de `User.dailySendLimit`). */
export const DEFAULT_DAILY_SEND_LIMIT = 200;

/**
 * Montée en charge progressive (cahier §5.2). Un compte doit faire ses
 * preuves — dans la durée **et** en volume — avant de pouvoir envoyer plus.
 * Paliers du plus élevé au plus bas : le premier satisfait l'emporte.
 */
export const SEND_LIMIT_TIERS = [
  { minAgeDays: 30, minLifetimeSends: 10_000, dailyLimit: 20_000 },
  { minAgeDays: 7, minLifetimeSends: 1_000, dailyLimit: 5_000 },
  { minAgeDays: 3, minLifetimeSends: 100, dailyLimit: 1_000 },
] as const;

/** Préfixe des clés Redis limitant la fréquence des recalculs de quota. */
export const RECOMPUTE_LIMIT_KEY_PREFIX = 'replimit:';

/**
 * Un recalcul de quota par heure et par client au maximum : le worker
 * appelle `recomputeDailyLimit` après chaque envoi, sans ce garde-fou un
 * client à 5 000 emails/jour déclencherait 5 000 recalculs.
 */
export const RECOMPUTE_LIMIT_TTL_SECONDS = 3_600;

/** Token d'injection du client Redis dédié au throttle des recalculs. */
export const REPUTATION_REDIS = 'REPUTATION_REDIS';
