import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthController } from '../auth/auth.controller';
import { DomainsController } from '../domains/domains.controller';
import { EmailsController } from '../emails/emails.controller';
import { HealthController } from '../health/health.controller';
import { CspReportController } from '../csp-report/csp-report.controller';
import { SnsWebhookController } from '../sns-webhook/sns-webhook.controller';
import {
  RateLimitPolicyService,
  buildRateLimitPolicies,
} from './rate-limit-policy.service';
import {
  DAY_WINDOW_MS,
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

    expect(policies[RATE_LIMIT_POLICY.REGISTER].windows).toEqual({
      [RATE_LIMIT_WINDOW.HOUR]: {
        limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
        ttl: HOUR_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.HOUR_ALT]: {
        limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
        ttl: HOUR_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.DAY]: {
        limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY,
        ttl: DAY_WINDOW_MS,
      },
      [RATE_LIMIT_WINDOW.DAY_ALT]: {
        limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY,
        ttl: DAY_WINDOW_MS,
      },
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

    expect(
      policies[RATE_LIMIT_POLICY.CSP_REPORT].windows[RATE_LIMIT_WINDOW.MINUTE],
    ).toEqual({
      limit: RATE_LIMIT_DEFAULTS.CSP_REPORT_PER_MINUTE,
      ttl: MINUTE_WINDOW_MS,
    });
  });

  it('compte les rapports CSP par IP, faute d’identité à compter', () => {
    // Route publique et non authentifiée : il n'y a ni utilisateur ni clé
    // API derrière un rapport de violation.
    expect(policies[RATE_LIMIT_POLICY.CSP_REPORT].tracker).toBe(
      TRACKER_KIND.IP,
    );
    expect(policies[RATE_LIMIT_POLICY.CSP_REPORT].exempt).toBe(false);
    expect(RATE_LIMIT_DEFAULTS.CSP_REPORT_PER_MINUTE).toBeLessThan(
      RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
    );
  });

  it('laisse passer SNS plus largement que le budget par défaut', () => {
    // Bloquer AWS trop tôt nous ferait perdre bounces et plaintes : sa limite
    // doit rester au-dessus du plafond générique.
    expect(RATE_LIMIT_DEFAULTS.SNS_PER_MINUTE).toBeGreaterThan(
      RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
    );
  });

  it("plafonne l'inscription sur 24 h, pas seulement sur une heure", () => {
    // Le trou que cette fenêtre bouche : 3 comptes par heure font 72 comptes
    // par jour pour un robot qui sait attendre.
    const jour =
      policies[RATE_LIMIT_POLICY.REGISTER].windows[RATE_LIMIT_WINDOW.DAY];

    expect(jour).toEqual({
      limit: RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY,
      ttl: DAY_WINDOW_MS,
    });
    expect(jour!.limit).toBeLessThan(
      RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR * 24,
    );

    // Compté aussi par adresse visée : changer d'IP ne suffit pas à rejouer
    // indéfiniment la même adresse.
    expect(
      policies[RATE_LIMIT_POLICY.REGISTER].windows[RATE_LIMIT_WINDOW.DAY_ALT],
    ).toEqual(jour);
  });

  it('laisse la fenêtre journalière au-dessus de la fenêtre horaire', () => {
    // Sinon la fenêtre horaire deviendrait inatteignable et le message de
    // refus mentirait sur la raison du blocage.
    expect(RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY).toBeGreaterThan(
      RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
    );
  });

  it("n'impose la fenêtre journalière à aucune autre politique", () => {
    // Une fenêtre de 24 h sur une route ordinaire punirait un client
    // légitime bien au-delà de l'incident qui l'a déclenchée.
    const avecJour = Object.values(policies)
      .filter((policy) => policy.windows[RATE_LIMIT_WINDOW.DAY] !== undefined)
      .map((policy) => policy.id);

    expect(avecJour).toEqual([RATE_LIMIT_POLICY.REGISTER]);
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
      'RATE_LIMIT_CSP_REPORT_PER_MINUTE',
      'RATE_LIMIT_DEFAULT_PER_MINUTE',
      'RATE_LIMIT_DNS_CHECK_PER_HOUR',
      'RATE_LIMIT_DOMAIN_CHECK_PER_HOUR',
      'RATE_LIMIT_EMAILS_PER_MINUTE',
      'RATE_LIMIT_LOGIN_PER_HOUR',
      'RATE_LIMIT_LOGIN_PER_MINUTE',
      'RATE_LIMIT_REGISTER_PER_DAY',
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
    expect(
      resolver.policyFor(contextOf(CspReportController, 'receive')).id,
    ).toBe(RATE_LIMIT_POLICY.CSP_REPORT);
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
    expect(resolver.windowFor(register, RATE_LIMIT_WINDOW.DAY)?.limit).toBe(
      RATE_LIMIT_DEFAULTS.REGISTER_PER_DAY,
    );
    // La connexion, elle, n'a pas de fenêtre journalière : c'est le
    // verrouillage progressif qui prend le relais dans la durée.
    expect(resolver.windowFor(login, RATE_LIMIT_WINDOW.DAY)).toBeUndefined();
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
