/** Endpoint officiel de vérification Cloudflare Turnstile. */
export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Délai maximal accordé à `siteverify`. Au-delà, on considère Cloudflare
 * injoignable et on refuse l'inscription (échec fermé, voir `CaptchaService`).
 */
export const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;

/** Message unique renvoyé pour tout échec de captcha, quelle qu'en soit la cause. */
export const CAPTCHA_FAILED_MESSAGE =
  'Vérification anti-robot échouée, réessayez.';
