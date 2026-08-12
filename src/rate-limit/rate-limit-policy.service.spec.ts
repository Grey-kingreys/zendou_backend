import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthController } from '../auth/auth.controller';
import { DomainsController } from '../domains/domains.controller';
import { EmailsController } from '../emails/emails.controller';
import { HealthController } from '../health/health.controller';
import { SnsWebhookController } from '../sns-webhook/sns-webhook.controller';
import {
  RateLimitPolicyService,
  buildRateLimitPolicies,
} from './rate-limit-policy.service';
import {
  HOUR_WINDOW_MS,
  MINUTE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_POLICY,
  RATE_LIMIT_WINDOW,
  TRACKER_KIND,
} from './rate-limit.constants';

/**
 * Contexte d'exécution minimal pointant sur une vraie méthode d'un vrai
 * contrôleur : les décorateurs `@RateLimit(...)` réellement posés sur le code
 * de production sont donc ce qui est testé, pas une copie.
 */
function contextOf(
  controller: new (...args: never[]) => unknown,
  method: string,
): ExecutionContext {
  const handler: unknown = (controller.prototype as Record<string, unknown>)[
    method
  ];

  return {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

const service = (overrides: Record<string, number> = {}) =>
  new RateLimitPolicyService({
    get: (name: string) => overrides[name],
  } as unknown as ConfigService);

describe('buildRateLimitPolicies', () => {
  const policies = buildRateLimitPolicies((_name, fallback) => fallback);

  it('applique les limites documentées par défaut', () => {
    expect(policies[RATE_LIMIT_POLICY.DEFAULT].windows).toEqual({
      [RATE_LIMIT_WINDOW.MINUTE]: {
        limit: RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
        ttl: MINUTE_WINDOW_MS,
      },
    });

    expect(policies[RATE_LIMIT_POLICY.LOGIN].windows).toEqual({
      [RATE_LIMIT_WINDOW.MINUTE]: {
        limit: RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE,
        ttl: MINUTE_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.HOUR]: {
        limit: RATE_LIMIT_DEFAULTS.LOGIN_PER_HOUR,
        ttl: HOUR_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.MINUTE_ALT]: {
        limit: RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE,
        ttl: MINUTE_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.HOUR_ALT]: {
        limit: RATE_LIMIT_DEFAULTS.LOGIN_PER_HOUR,
        ttl: HOUR_WINDOW_MS,
      },
    });

    expect(
      policies[RATE_LIMIT_POLICY.REGISTER].windows[RATE_LIMIT_WINDOW.HOUR],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
      ttl: HOUR_WINDOW_MS,
    });

    expect(
      policies[RATE_LIMIT_POLICY.CHANGE_PASSWORD].windows[
        RATE_LIMIT_WINDOW.HOUR
      ],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.CHANGE_PASSWORD_PER_HOUR,
      ttl: HOUR_WINDOW_MS,
    });

    expect(
      policies[RATE_LIMIT_POLICY.EMAIL_SEND].windows[RATE_LIMIT_WINDOW.MINUTE],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
      ttl: MINUTE_WINDOW_MS,
    });

    expect(
      policies[RATE_LIMIT_POLICY.DOMAIN_CHECK].windows[RATE_LIMIT_WINDOW.HOUR],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.DOMAIN_CHECK_PER_HOUR,
      ttl: HOUR_WINDOW_MS,
    });

    expect(
      policies[RATE_LIMIT_POLICY.SNS_WEBHOOK].windows[RATE_LIMIT_WINDOW.MINUTE],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.SNS_PER_MINUTE,
      ttl: MINUTE_WINDOW_MS,
    });

    expect(
      policies[RATE_LIMIT_POLICY.DNS_CHECK].windows[RATE_LIMIT_WINDOW.HOUR],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.DNS_CHECK_PER_HOUR,
      ttl: HOUR_WINDOW_MS,
    });
  });

  it('laisse passer SNS plus largement que le budget par défaut', () => {
    // Bloquer AWS trop tôt nous ferait perdre bounces et plaintes : sa limite
    // doit rester au-dessus du plafond générique.
    expect(RATE_LIMIT_DEFAULTS.SNS_PER_MINUTE).toBeGreaterThan(
      RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
    );
  });

  it('exempte totalement la politique EXEMPT', () => {
    expect(policies[RATE_LIMIT_POLICY.EXEMPT].exempt).toBe(true);
    expect(policies[RATE_LIMIT_POLICY.EXEMPT].windows).toEqual({});
  });

  it('compte les routes authentifiées par identité et jamais par IP', () => {
    // NAT opérateur : des milliers d'abonnés Orange/MTN partagent une IP
    // publique. Une limite par IP sur ces routes les punirait tous.
    expect(policies[RATE_LIMIT_POLICY.CHANGE_PASSWORD].tracker).toBe(
      TRACKER_KIND.USER,
    );
    expect(policies[RATE_LIMIT_POLICY.DOMAIN_CHECK].tracker).toBe(
      TRACKER_KIND.USER,
    );
    expect(policies[RATE_LIMIT_POLICY.DNS_CHECK].tracker).toBe(
      TRACKER_KIND.USER,
    );
    expect(policies[RATE_LIMIT_POLICY.EMAIL_SEND].tracker).toBe(
      TRACKER_KIND.API_KEY,
    );
    expect(policies[RATE_LIMIT_POLICY.LOGIN].tracker).toBe(
      TRACKER_KIND.IP_AND_EMAIL,
    );
    expect(policies[RATE_LIMIT_POLICY.REGISTER].tracker).toBe(
      TRACKER_KIND.IP_AND_EMAIL,
    );
  });

  it("lit chaque limite depuis sa variable d'environnement", () => {
    const read = jest.fn((_name: string, fallback: number) => fallback);
    buildRateLimitPolicies(read);

    expect(read.mock.calls.map(([name]) => name).sort()).toEqual([
      'RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR',
      'RATE_LIMIT_DEFAULT_PER_MINUTE',
      'RATE_LIMIT_DNS_CHECK_PER_HOUR',
      'RATE_LIMIT_DOMAIN_CHECK_PER_HOUR',
      'RATE_LIMIT_EMAILS_PER_MINUTE',
      'RATE_LIMIT_LOGIN_PER_HOUR',
      'RATE_LIMIT_LOGIN_PER_MINUTE',
      'RATE_LIMIT_REGISTER_PER_HOUR',
      'RATE_LIMIT_RESEND_CONFIRMATION_PER_HOUR',
      'RATE_LIMIT_SNS_PER_MINUTE',
    ]);
  });
});

describe('RateLimitPolicyService', () => {
  it('associe chaque route sensible à sa politique', () => {
    const resolver = service();

    expect(resolver.policyFor(contextOf(AuthController, 'login')).id).toBe(
      RATE_LIMIT_POLICY.LOGIN,
    );
    expect(resolver.policyFor(contextOf(AuthController, 'register')).id).toBe(
      RATE_LIMIT_POLICY.REGISTER,
    );
    expect(
      resolver.policyFor(contextOf(AuthController, 'changePassword')).id,
    ).toBe(RATE_LIMIT_POLICY.CHANGE_PASSWORD);
    expect(resolver.policyFor(contextOf(EmailsController, 'send')).id).toBe(
      RATE_LIMIT_POLICY.EMAIL_SEND,
    );
    expect(resolver.policyFor(contextOf(DomainsController, 'check')).id).toBe(
      RATE_LIMIT_POLICY.DOMAIN_CHECK,
    );
    expect(
      resolver.policyFor(contextOf(DomainsController, 'dnsCheck')).id,
    ).toBe(RATE_LIMIT_POLICY.DNS_CHECK);
    expect(
      resolver.policyFor(contextOf(SnsWebhookController, 'receive')).id,
    ).toBe(RATE_LIMIT_POLICY.SNS_WEBHOOK);
  });

  it('retombe sur la politique par défaut pour une route non décorée', () => {
    const resolver = service();
    const policy = resolver.policyFor(contextOf(AuthController, 'me'));

    expect(policy.id).toBe(RATE_LIMIT_POLICY.DEFAULT);
    expect(policy.tracker).toBe(TRACKER_KIND.IDENTITY);
  });

  it('exempte /health', () => {
    // Le HEALTHCHECK Docker frappe cette route toutes les 30 s : la compter
    // finirait par déclarer le conteneur unhealthy.
    const resolver = service();

    expect(resolver.isExempt(contextOf(HealthController, 'check'))).toBe(true);
    expect(
      resolver.windowFor(
        contextOf(HealthController, 'check'),
        RATE_LIMIT_WINDOW.MINUTE,
      ),
    ).toBeUndefined();
  });

  it('ne considère exempte aucune autre route', () => {
    const resolver = service();

    expect(resolver.isExempt(contextOf(AuthController, 'login'))).toBe(false);
    expect(resolver.isExempt(contextOf(AuthController, 'me'))).toBe(false);
    expect(resolver.isExempt(contextOf(EmailsController, 'send'))).toBe(false);
  });

  it("n'applique à une route que les fenêtres de sa politique", () => {
    const resolver = service();
    const login = contextOf(AuthController, 'login');
    const register = contextOf(AuthController, 'register');

    expect(resolver.windowFor(login, RATE_LIMIT_WINDOW.MINUTE)?.limit).toBe(
      RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE,
    );
    expect(resolver.windowFor(login, RATE_LIMIT_WINDOW.HOUR)?.limit).toBe(
      RATE_LIMIT_DEFAULTS.LOGIN_PER_HOUR,
    );
    // L'inscription n'a pas de fenêtre à la minute : seule l'heure compte.
    expect(
      resolver.windowFor(register, RATE_LIMIT_WINDOW.MINUTE),
    ).toBeUndefined();
    expect(resolver.windowFor(register, RATE_LIMIT_WINDOW.HOUR)?.limit).toBe(
      RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
    );
  });

  it("honore les variables d'environnement", () => {
    const resolver = service({ RATE_LIMIT_LOGIN_PER_MINUTE: 2 });

    expect(
      resolver.windowFor(
        contextOf(AuthController, 'login'),
        RATE_LIMIT_WINDOW.MINUTE,
      )?.limit,
    ).toBe(2);
  });
});
