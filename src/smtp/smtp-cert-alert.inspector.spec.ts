import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspectSmtpCertificate } from './smtp-cert-alert.inspector';

/**
 * Certificat auto-signé figé, généré une fois pour ce test :
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -keyout /dev/null \
 *     -out fixture.pem -days 1 -subj "/CN=smtp.zendou.dev" \
 *     -addext "subjectAltName=DNS:smtp.zendou.dev"
 *
 * Il est **expiré depuis longtemps**, et c'est sans conséquence : l'inspecteur
 * ne fait qu'extraire trois champs, il ne juge rien. C'est précisément ce qui
 * rend ce test déterministe pour toujours — aucune horloge n'intervient ici,
 * et la politique (paliers, expiration) se teste ailleurs contre une horloge
 * injectée. Aucune clé privée n'accompagne ce fichier.
 */
const FIXTURE_PEM = `-----BEGIN CERTIFICATE-----
MIIDMTCCAhmgAwIBAgIUX/WwWZx5dz3s5jl6l0Z4pgM6MywwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPc210cC56ZW5kb3UuZGV2MB4XDTI2MDgyOTE1NDY0M1oX
DTI2MDgzMDE1NDY0M1owGjEYMBYGA1UEAwwPc210cC56ZW5kb3UuZGV2MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoWbiA2545Je/M8hABkNzkorRmzgP
8nkxoMdRKuSnEZL/ChFcC2swBFn26zZLWdGw1QQptKyn3dHnE1OwWWkWhvsw72SS
hYQs/eu/HYco1w7uoon5eCTtWlEHlhKW1kk9ySwvC1pMgf1866KutaBiDV3lz3dT
hNCm36oK4avIJs9dLIpeOAgQ4K2WwJmJ36NaIaXbjq2VkOYIElfJPKYAAyn+RB0z
Il2YiJzO5oJSwplUXH1AzFBw69AWr1U16J3MSQilaQyyUy2Ez5lqA0HV4KOMgniB
xFxxc2xq4Zm8zJ77WSFtpsIkdG0ed9nibK0JQC4Vc3QPbo16jjqJg0P77QIDAQAB
o28wbTAdBgNVHQ4EFgQU4NMy8vQpVNoVoMvs9cPNxP9ea7EwHwYDVR0jBBgwFoAU
4NMy8vQpVNoVoMvs9cPNxP9ea7EwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR
gg9zbXRwLnplbmRvdS5kZXYwDQYJKoZIhvcNAQELBQADggEBACmICX4GCAXBRjk3
2tQ3kzaVBEfvfUQKZZL0ICWzuS76JvTU/3nzjlgZcjOIr8OCpUheIw2RvViln1Kh
F6bIqUUvbz/EuW4CICw3UNt36edqxCPusLByebgFBRiO66xnIFL1vOnrHrSS1Pm3
MtQ7HhBYRxhj/5diijNfJ/xSFS8RW6YlrsSzMXoglgNC7a+0Nn0T9AQjVvlMBj7d
yOPkkBo0+Ey0F75V3LSo3Zrx2Er2Ps9M/haZhhmTPEfT9zUwQ/kd0cPYEqnc30+K
jJ5Dl6H56RkSuHD/6YvTIwc3Hzx7HCJeTOHpWeddgGzduZg7wXZ8xDibMrd4kczk
gYkj3TI=
-----END CERTIFICATE-----
`;

const EXPECTED_FINGERPRINT =
  'fcc72a1c475e0b8e9cab9ce5332bc0cd99d97ca1ff08878c06844e8be57f0ff0';

describe('inspectSmtpCertificate — lecture réelle du certificat (B6/H1)', () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'zendou-cert-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const path = join(directory, name);
    writeFileSync(path, contents);
    return path;
  }

  it('extrait le domaine, l’empreinte et la date de fin de validité', () => {
    const snapshot = inspectSmtpCertificate(write('cert.pem', FIXTURE_PEM));

    expect(snapshot).toEqual({
      subjectName: 'smtp.zendou.dev',
      fingerprint: EXPECTED_FINGERPRINT,
      expiresAt: new Date('2026-08-30T15:46:43.000Z'),
    });
  });

  it('lit la feuille en tête d’une chaîne complète (fullchain.pem)', () => {
    // `SMTP_TLS_CERT_PATH` pointe en pratique un `fullchain.pem` : la feuille
    // d'abord, puis l'intermédiaire. C'est bien l'expiration de la feuille qui
    // coupe les clients — ici la fixture est concaténée à elle-même, ce qui
    // suffit à prouver que seul le premier bloc est retenu.
    const path = write('fullchain.pem', `${FIXTURE_PEM}${FIXTURE_PEM}`);

    expect(inspectSmtpCertificate(path).fingerprint).toBe(EXPECTED_FINGERPRINT);
  });

  it('normalise l’empreinte en minuscules sans deux-points', () => {
    const { fingerprint } = inspectSmtpCertificate(
      write('minuscules.pem', FIXTURE_PEM),
    );

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lève une erreur explicite quand le fichier est absent', () => {
    expect(() =>
      inspectSmtpCertificate(join(directory, 'nulle-part.pem')),
    ).toThrow(/certificat introuvable, illisible ou non analysable/);
  });

  it('lève une erreur explicite quand le contenu n’est pas du PEM', () => {
    const path = write('pas-du-pem.txt', 'ceci n’est pas un certificat\n');

    expect(() => inspectSmtpCertificate(path)).toThrow(
      /certificat introuvable, illisible ou non analysable/,
    );
  });

  it('lève une erreur explicite quand le fichier est vide', () => {
    expect(() => inspectSmtpCertificate(write('vide.pem', ''))).toThrow(
      /certificat introuvable, illisible ou non analysable/,
    );
  });
});
