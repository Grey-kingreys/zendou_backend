export const EMAIL_SEND_QUEUE = 'email-send';

/**
 * File de la surveillance du certificat TLS du relais SMTP (B6/H1).
 *
 * Contrairement à `EMAIL_SEND_QUEUE`, elle n'est **pas** déclarée dans
 * `AppModule` : sa file et son worker sont créés par le planificateur, et
 * seulement quand `SMTP_RELAY_ENABLED` est vraie. Le nom vit tout de même ici,
 * avec les autres, pour qu'on puisse inventorier les files du service en un
 * seul endroit.
 */
export const SMTP_CERT_CHECK_QUEUE = 'smtp-cert-check';
