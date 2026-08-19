import { readFileSync } from 'fs';
import { join } from 'path';
import { validateEnv } from './env.schema';

/**
 * Contrôle « cassant » (B6/S10) : toute variable `SMTP_*` déclarée dans
 * `env.schema.ts` doit avoir sa ligne dans `.env.example`, sans quoi un
 * porteur qui recopie ce fichier obtiendrait un comportement par défaut sans
 * même savoir que la variable existe. On dérive la liste des clés du schéma
 * en le faisant réellement valider une configuration (plutôt que d'exporter
 * `baseEnvSchema` pour l'introspecter) : c'est la même source de vérité que
 * celle que `validateEnv` applique au démarrage de l'app, jamais une copie
 * qui pourrait diverger.
 */
describe('.env.example — cohérence avec les variables SMTP_* du schéma', () => {
  it('ne laisse aucune variable SMTP_* du schéma non documentée', () => {
    const config = validateEnv({
      DATABASE_URL: 'postgresql://zendou:zendou@localhost:5433/zendou',
      REDIS_URL: 'redis://localhost:6379',
      FRONTEND_ORIGIN: 'http://localhost:3000',
      // Active toutes les branches optionnelles du schéma pour que
      // `Object.keys` reflète bien la totalité des clés SMTP_* — les ports
      // par défaut restent non vides, donc pas besoin de certificat ici
      // (NODE_ENV reste 'test').
      SMTP_RELAY_ENABLED: 'true',
    });

    const schemaSmtpKeys = Object.keys(config).filter((key) =>
      key.startsWith('SMTP_'),
    );

    // Preuve que le test ne serait pas vide de sens si le schéma changeait de
    // forme sous nos pieds.
    expect(schemaSmtpKeys.length).toBeGreaterThan(0);

    const envExample = readFileSync(
      join(__dirname, '..', '..', '.env.example'),
      'utf-8',
    );
    const documentedKeys = new Set(
      envExample
        .split('\n')
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((key): key is string => Boolean(key)),
    );

    const missing = schemaSmtpKeys.filter((key) => !documentedKeys.has(key));

    expect(missing).toEqual([]);
  });
});
