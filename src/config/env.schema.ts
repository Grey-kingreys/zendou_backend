import { z } from 'zod';

/** `true`, `1`, `yes`, `on` (insensible à la casse) valent vrai ; tout le reste faux. */
const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .default(false)
  .transform((value) =>
    typeof value === 'boolean'
      ? value
      : TRUTHY_VALUES.includes(value.trim().toLowerCase()),
  );

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url(),

  // AWS SES / SNS — optionnelles pour l'instant (pas de module d'envoi)
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().optional(),
  MAIL_FROM_NAME: z.string().optional(),
  SES_SMTP_HOST: z.string().optional(),
  SES_SMTP_PORT: z.string().optional(),
  SES_SMTP_USER: z.string().optional(),
  SES_SMTP_PASSWORD: z.string().optional(),
  SES_SNS_TOPIC_ARN: z.string().optional(),

  // Contournement de la vérification de signature SNS (tests locaux / démo).
  // Interdit en production : sans signature, n'importe qui peut forger un
  // bounce et faire suppressor des adresses arbitraires.
  SNS_SKIP_SIGNATURE_VALIDATION: booleanFromEnv,
});

export const envSchema = baseEnvSchema.refine(
  (env) =>
    !(env.NODE_ENV === 'production' && env.SNS_SKIP_SIGNATURE_VALIDATION),
  {
    path: ['SNS_SKIP_SIGNATURE_VALIDATION'],
    message:
      'ne peut pas être activé quand NODE_ENV=production (signature SNS obligatoire)',
  },
);

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration d'environnement invalide:\n${issues}`);
  }

  return result.data;
}
