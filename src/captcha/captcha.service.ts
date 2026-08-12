import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TURNSTILE_VERIFY_TIMEOUT_MS,
  TURNSTILE_VERIFY_URL,
} from './captcha.constants';

/** Forme (partielle) de la réponse JSON de `siteverify`. */
interface TurnstileSiteverifyResponse {
  success: boolean;
  ['error-codes']?: string[];
}

/**
 * Vérification Cloudflare Turnstile — protège uniquement
 * `POST /v1/auth/register` (voir `CaptchaGuard`), en complément de la
 * limitation de débit déjà en place (3 inscriptions/heure/IP) : la création
 * massive de comptes est le vecteur qui amène un spammeur sur le compte SES
 * partagé.
 *
 * **Optionnelle par construction** : sans `TURNSTILE_SECRET_KEY`, `isEnabled`
 * vaut `false` et `verify` réussit toujours sans appel réseau — dev, tests,
 * et débrayage d'urgence en production restent possibles sans toucher au
 * code (voir `env.schema.ts`).
 *
 * **Échec fermé** : si Cloudflare répond une erreur ou n'est pas joignable
 * dans les `TURNSTILE_VERIFY_TIMEOUT_MS` impartis, `verify` renvoie `false` —
 * l'inscription est refusée. Une inscription manquée se retente en quelques
 * secondes par un utilisateur légitime ; un `siteverify` indisponible est au
 * contraire exactement la fenêtre qu'un abus chercherait à exploiter.
 *
 * Ni le jeton ni le secret ne sont jamais journalisés, y compris en erreur.
 */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);
  private readonly secretKey?: string;

  constructor(configService: ConfigService) {
    this.secretKey = configService.get<string>('TURNSTILE_SECRET_KEY');
  }

  get isEnabled(): boolean {
    return Boolean(this.secretKey);
  }

  /**
   * `remoteIp` doit venir de la même résolution que la limitation de débit
   * (`resolveClientIp`), pour que Cloudflare voie la vraie IP du client
   * derrière Traefik plutôt que celle du proxy.
   */
  async verify(token: string | undefined, remoteIp: string): Promise<boolean> {
    if (!this.secretKey) {
      return true;
    }

    if (!token) {
      return false;
    }

    const body = new URLSearchParams({
      secret: this.secretKey,
      response: token,
      remoteip: remoteIp,
    });

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          `Turnstile siteverify a répondu HTTP ${response.status} — inscription refusée (échec fermé)`,
        );
        return false;
      }

      const payload = (await response.json()) as TurnstileSiteverifyResponse;
      return payload.success === true;
    } catch (error) {
      this.logger.error(
        `Turnstile siteverify injoignable — inscription refusée (échec fermé) : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }`,
      );
      return false;
    }
  }
}
