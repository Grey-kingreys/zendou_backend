import { z } from 'zod';

/** `true`, `1`, `yes`, `on` (insensible à la casse) valent vrai ; tout le reste faux. */
const TRUTHY_VALUES = ['1', 'true', 'yes', 'on'];

/** Nom par défaut du compte admin créé au démarrage si `ADMIN_NAME` est absente. */
export const DEFAULT_ADMIN_NAME = 'Administrateur Zendou';

/** Une chaîne vide (ou faite d'espaces) équivaut à une variable absente. */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

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

  // Compte administrateur créé automatiquement au démarrage (voir SeedModule).
  // Entièrement optionnelles : sans elles, l'app démarre normalement et le
  // seed se contente de logger qu'il est ignoré.
  ADMIN_EMAIL: z.preprocess(
    emptyToUndefined,
    z.string().trim().email('doit être une adresse email valide').optional(),
  ),
  ADMIN_PASSWORD: z.preprocess(
    emptyToUndefined,
    z.string().min(12, 'doit contenir au moins 12 caractères').optional(),
  ),
  ADMIN_NAME: z
    .preprocess(emptyToUndefined, z.string().trim().optional())
    .default(DEFAULT_ADMIN_NAME),
});

export const envSchema = baseEnvSchema
  .refine(
    (env) =>
      !(env.NODE_ENV === 'production' && env.SNS_SKIP_SIGNATURE_VALIDATION),
    {
      path: ['SNS_SKIP_SIGNATURE_VALIDATION'],
      message:
        'ne peut pas être activé quand NODE_ENV=production (signature SNS obligatoire)',
    },
  )
  .refine((env) => Boolean(env.ADMIN_EMAIL) === Boolean(env.ADMIN_PASSWORD), {
    path: ['ADMIN_EMAIL'],
    message:
      'ADMIN_EMAIL et ADMIN_PASSWORD doivent être renseignées ensemble (configuration admin incomplète)',
  });

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
