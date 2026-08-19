import { readFileSync } from 'fs';

/** Couple clé privée / certificat lu depuis le disque. */
export interface SmtpTlsMaterial {
  key: Buffer;
  cert: Buffer;
}

/** Chemins des deux fichiers, tels que fournis par l'environnement. */
export interface SmtpTlsPaths {
  certPath: string;
  keyPath: string;
}

/**
 * Lit le certificat et la clé privée du relais (§1.4 du plan B6).
 *
 * Traefik garde ses certificats dans son `acme.json` et ne les expose pas :
 * le processus SMTP a besoin de vrais fichiers, produits par certbot/lego sur
 * l'hôte et montés en lecture seule. Toute erreur de lecture est convertie en
 * `Error` au message explicite — l'appelant en fait un échec de démarrage
 * bruyant (A19 : « on ne démarre jamais un serveur de soumission en clair »),
 * ou, lors d'un rechargement à chaud, un journal d'erreur qui laisse en place
 * l'ancien contexte encore valide.
 */
export function readSmtpTlsMaterial({
  certPath,
  keyPath,
}: SmtpTlsPaths): SmtpTlsMaterial {
  return {
    cert: readTlsFile(certPath, 'certificat', 'SMTP_TLS_CERT_PATH'),
    key: readTlsFile(keyPath, 'clé privée', 'SMTP_TLS_KEY_PATH'),
  };
}

function readTlsFile(path: string, label: string, variable: string): Buffer {
  try {
    const contents = readFileSync(path);

    if (contents.length === 0) {
      throw new Error('fichier vide');
    }

    return contents;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Certificat TLS du relais SMTP illisible : ${label} introuvable ou illisible à « ${path} » (${variable}) — ${detail}`,
    );
  }
}
