import { readFileSync } from 'fs';
import { X509Certificate } from 'crypto';

/**
 * Ce que la surveillance retient d'un certificat (B6/H1).
 *
 * Volontairement réduit à trois champs : le nom à afficher, l'échéance, et
 * l'empreinte qui sert de clé d'anti-spam. Tout le reste du certificat ne
 * regarde pas cette fonctionnalité.
 */
export interface SmtpCertificateSnapshot {
  /**
   * Nom du domaine porté par le certificat : `CN` du sujet, à défaut le
   * premier `DNS:` du SAN. Sert au message d'alerte **et** aux commandes de
   * renouvellement qu'il contient.
   */
  subjectName: string;

  /**
   * `fingerprint256` normalisé (minuscules, sans les deux-points). C'est
   * l'identité du certificat : elle change à chaque renouvellement, ce qui
   * réarme mécaniquement les paliers d'alerte.
   */
  fingerprint: string;

  /** Fin de validité (`notAfter`). */
  expiresAt: Date;
}

/**
 * Lecture + analyse du certificat, sous forme de port injectable.
 *
 * C'est **le seul** point de contact avec le disque de toute la
 * fonctionnalité. En faire une dépendance injectée sert deux fois : les tests
 * de politique (paliers, anti-spam, contenu de l'email) n'ont jamais besoin
 * d'un vrai certificat — donc jamais d'un certificat qui expirerait un jour et
 * casserait la CI — et l'assertion « relais désactivé ⇒ **aucune lecture de
 * fichier** » devient littérale : le double n'est simplement pas appelé.
 */
export type SmtpCertificateInspector = (
  certPath: string,
) => SmtpCertificateSnapshot;

/** Jeton d'injection du port {@link SmtpCertificateInspector}. */
export const SMTP_CERT_INSPECTOR = Symbol('SMTP_CERT_INSPECTOR');

/** Horloge injectable — aucun appel direct à `Date.now()` dans le service. */
export type SmtpCertAlertClock = () => Date;

/** Jeton d'injection de l'horloge {@link SmtpCertAlertClock}. */
export const SMTP_CERT_ALERT_CLOCK = Symbol('SMTP_CERT_ALERT_CLOCK');

/**
 * Implémentation réelle : `readFileSync` + `crypto.X509Certificate`, tous deux
 * natifs — aucune bibliothèque tierce pour lire un X.509.
 *
 * Le fichier pointé par `SMTP_TLS_CERT_PATH` est en général une chaîne
 * complète (`fullchain.pem`) ; `X509Certificate` retient le **premier**
 * certificat du tampon, c'est-à-dire la feuille, qui est bien celle dont
 * l'expiration coupe les clients.
 *
 * Toute défaillance — fichier absent, droits insuffisants, contenu qui n'est
 * pas du PEM — sort en `Error` au message explicite. L'appelant n'a pas à
 * distinguer ces cas : ils appellent la même alerte, et pour la même raison
 * (au prochain redéploiement, le relais refuserait de démarrer).
 */
export const inspectSmtpCertificate: SmtpCertificateInspector = (certPath) => {
  let certificate: X509Certificate;

  try {
    certificate = new X509Certificate(readFileSync(certPath));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new Error(
      `certificat introuvable, illisible ou non analysable à « ${certPath} » — ${detail}`,
    );
  }

  const expiresAt = certificate.validToDate;

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(
      `date de fin de validité illisible dans le certificat « ${certPath} » (notAfter : ${certificate.validTo})`,
    );
  }

  return {
    subjectName: extractSubjectName(certificate),
    fingerprint: certificate.fingerprint256.replace(/:/g, '').toLowerCase(),
    expiresAt,
  };
};

/**
 * Nom à afficher : `CN` du sujet en priorité, premier `DNS:` du SAN à défaut.
 *
 * Les certificats Let's Encrypt récents portent toujours un CN, mais l'ACME
 * n'y oblige pas : un certificat sans CN existerait, et une alerte qui ne dit
 * pas de quel domaine elle parle ne vaut pas grand-chose.
 */
function extractSubjectName(certificate: X509Certificate): string {
  const commonName = /^CN=(.+)$/m.exec(certificate.subject)?.[1]?.trim();

  if (commonName) {
    return commonName;
  }

  const firstDns = /DNS:([^,\s]+)/.exec(certificate.subjectAltName ?? '')?.[1];

  return firstDns ?? 'domaine inconnu';
}
