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

/**
 * File de la tâche répétable de rétention (RET-12 : purge des jobs en échec
 * et du journal des envois). Même raisonnement que {@link SMTP_CERT_CHECK_QUEUE} :
 * elle n'est pas déclarée dans `AppModule`, son propre planificateur la crée.
 * Contrairement à la surveillance du certificat, ce planificateur est **actif
 * dans tous les environnements** (garantie produit, pas une option), voir
 * `retention.module.ts`.
 */
export const RETENTION_QUEUE = 'retention-purge';

/**
 * File du traitement quotidien des comptes inactifs (ANON-1). Même montage
 * que `SMTP_CERT_CHECK_QUEUE` : file et worker créés par le planificateur, pas
 * déclarés dans `AppModule`.
 */
export const ACCOUNT_INACTIVITY_QUEUE = 'account-inactivity';
