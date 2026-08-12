import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HOUR_WINDOW_MS,
  MINUTE_WINDOW_MS,
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_POLICY,
  RATE_LIMIT_WINDOW,
  TRACKER_KIND,
} from './rate-limit.constants';
import { readRateLimitPolicyId } from './rate-limit.decorator';
import type {
  RateLimitPolicyId,
  RateLimitWindow,
  RateLimitWindowName,
  ResolvedRateLimitPolicy,
} from './rate-limit.types';

/** Lecture d'une limite : variable d'environnement, sinon défaut documenté. */
export type LimitReader = (envName: string, fallback: number) => number;

const perMinute = (limit: number): RateLimitWindow => ({
  limit,
  ttl: MINUTE_WINDOW_MS,
});

const perHour = (limit: number): RateLimitWindow => ({
  limit,
  ttl: HOUR_WINDOW_MS,
});

/**
 * Construit la table complète des politiques à partir de l'environnement.
 *
 * Fonction pure (aucune dépendance Nest) pour rester testable telle quelle.
 */
export function buildRateLimitPolicies(
  read: LimitReader,
): Record<RateLimitPolicyId, ResolvedRateLimitPolicy> {
  const loginPerMinute = read(
    'RATE_LIMIT_LOGIN_PER_MINUTE',
    RATE_LIMIT_DEFAULTS.LOGIN_PER_MINUTE,
  );
  const loginPerHour = read(
    'RATE_LIMIT_LOGIN_PER_HOUR',
    RATE_LIMIT_DEFAULTS.LOGIN_PER_HOUR,
  );
  const registerPerHour = read(
    'RATE_LIMIT_REGISTER_PER_HOUR',
    RATE_LIMIT_DEFAULTS.REGISTER_PER_HOUR,
  );

  return {
    [RATE_LIMIT_POLICY.DEFAULT]: {
      id: RATE_LIMIT_POLICY.DEFAULT,
      tracker: TRACKER_KIND.IDENTITY,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.MINUTE]: perMinute(
          read(
            'RATE_LIMIT_DEFAULT_PER_MINUTE',
            RATE_LIMIT_DEFAULTS.DEFAULT_PER_MINUTE,
          ),
        ),
      },
    },

    // Connexion : deux fenêtres cumulées (rafale courte + acharnement lent),
    // chacune comptée en parallèle sur l'IP et sur l'email visé.
    [RATE_LIMIT_POLICY.LOGIN]: {
      id: RATE_LIMIT_POLICY.LOGIN,
      tracker: TRACKER_KIND.IP_AND_EMAIL,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.MINUTE]: perMinute(loginPerMinute),
        [RATE_LIMIT_WINDOW.HOUR]: perHour(loginPerHour),
        [RATE_LIMIT_WINDOW.MINUTE_ALT]: perMinute(loginPerMinute),
        [RATE_LIMIT_WINDOW.HOUR_ALT]: perHour(loginPerHour),
      },
    },

    // Inscription : le compteur qui compte vraiment est celui par IP (un
    // attaquant change d'email à chaque tentative). Le compteur par email est
    // conservé pour le cas de la même adresse rejouée en boucle.
    [RATE_LIMIT_POLICY.REGISTER]: {
      id: RATE_LIMIT_POLICY.REGISTER,
      tracker: TRACKER_KIND.IP_AND_EMAIL,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.HOUR]: perHour(registerPerHour),
        [RATE_LIMIT_WINDOW.HOUR_ALT]: perHour(registerPerHour),
      },
    },

    [RATE_LIMIT_POLICY.CHANGE_PASSWORD]: {
      id: RATE_LIMIT_POLICY.CHANGE_PASSWORD,
      tracker: TRACKER_KIND.USER,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.HOUR]: perHour(
          read(
            'RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR',
            RATE_LIMIT_DEFAULTS.CHANGE_PASSWORD_PER_HOUR,
          ),
        ),
      },
    },

    // Renvoi du lien de confirmation : compté par utilisateur, jamais par IP.
    // La cible à protéger n'est pas l'infrastructure mais la boîte aux lettres
    // du titulaire de l'adresse — voir `RESEND_CONFIRMATION_PER_HOUR`.
    [RATE_LIMIT_POLICY.RESEND_CONFIRMATION]: {
      id: RATE_LIMIT_POLICY.RESEND_CONFIRMATION,
      tracker: TRACKER_KIND.USER,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.HOUR]: perHour(
          read(
            'RATE_LIMIT_RESEND_CONFIRMATION_PER_HOUR',
            RATE_LIMIT_DEFAULTS.RESEND_CONFIRMATION_PER_HOUR,
          ),
        ),
      },
    },

    [RATE_LIMIT_POLICY.EMAIL_SEND]: {
      id: RATE_LIMIT_POLICY.EMAIL_SEND,
      tracker: TRACKER_KIND.API_KEY,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.MINUTE]: perMinute(
          read(
            'RATE_LIMIT_EMAILS_PER_MINUTE',
            RATE_LIMIT_DEFAULTS.EMAILS_PER_MINUTE,
          ),
        ),
      },
    },

    [RATE_LIMIT_POLICY.DOMAIN_CHECK]: {
      id: RATE_LIMIT_POLICY.DOMAIN_CHECK,
      tracker: TRACKER_KIND.USER,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.HOUR]: perHour(
          read(
            'RATE_LIMIT_DOMAIN_CHECK_PER_HOUR',
            RATE_LIMIT_DEFAULTS.DOMAIN_CHECK_PER_HOUR,
          ),
        ),
      },
    },

    // Comme DOMAIN_CHECK : compté par utilisateur, jamais par IP (NAT
    // opérateur guinéen). Fenêtre horaire plus large, car cet appel ne coûte
    // rien côté AWS — seulement des résolutions DNS locales.
    [RATE_LIMIT_POLICY.DNS_CHECK]: {
      id: RATE_LIMIT_POLICY.DNS_CHECK,
      tracker: TRACKER_KIND.USER,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.HOUR]: perHour(
          read(
            'RATE_LIMIT_DNS_CHECK_PER_HOUR',
            RATE_LIMIT_DEFAULTS.DNS_CHECK_PER_HOUR,
          ),
        ),
      },
    },

    [RATE_LIMIT_POLICY.SNS_WEBHOOK]: {
      id: RATE_LIMIT_POLICY.SNS_WEBHOOK,
      tracker: TRACKER_KIND.IP,
      exempt: false,
      windows: {
        [RATE_LIMIT_WINDOW.MINUTE]: perMinute(
          read('RATE_LIMIT_SNS_PER_MINUTE', RATE_LIMIT_DEFAULTS.SNS_PER_MINUTE),
        ),
      },
    },

    [RATE_LIMIT_POLICY.EXEMPT]: {
      id: RATE_LIMIT_POLICY.EXEMPT,
      tracker: TRACKER_KIND.IP,
      exempt: true,
      windows: {},
    },
  };
}

/**
 * Expose la politique applicable à une requête donnée, limites déjà résolues
 * depuis l'environnement au démarrage (aucune lecture de config par requête).
 */
@Injectable()
export class RateLimitPolicyService {
  private readonly policies: Record<RateLimitPolicyId, ResolvedRateLimitPolicy>;

  constructor(configService: ConfigService) {
    this.policies = buildRateLimitPolicies(
      (envName, fallback) => configService.get<number>(envName) ?? fallback,
    );
  }

  /** Politique de la route courante (jamais `undefined`). */
  policyFor(context: ExecutionContext): ResolvedRateLimitPolicy {
    return (
      this.policies[readRateLimitPolicyId(context)] ??
      this.policies[RATE_LIMIT_POLICY.DEFAULT]
    );
  }

  /** Fenêtre applicable, ou `undefined` si ce compteur ne concerne pas la route. */
  windowFor(
    context: ExecutionContext,
    windowName: RateLimitWindowName,
  ): RateLimitWindow | undefined {
    return this.policyFor(context).windows[windowName];
  }

  /** `true` uniquement pour les routes explicitement exemptées (`/health`). */
  isExempt(context: ExecutionContext): boolean {
    return this.policyFor(context).exempt;
  }
}
