import { createHash } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { TOO_MANY_REQUESTS_MESSAGE } from '../rate-limit/rate-limit.constants';
import {
  LOGIN_LOCKOUT_BLOCK_PREFIX,
  LOGIN_LOCKOUT_DEFAULTS,
  LOGIN_LOCKOUT_FAIL_PREFIX,
  LOGIN_LOCKOUT_LEVEL_PREFIX,
  LOGIN_LOCKOUT_LEVEL_TTL_SECONDS,
  SESSION_REDIS,
} from './auth.constants';

/** Corps du 429 rendu par {@link LoginLockoutService.assertNotLocked}. */
export interface LoginLockedBody {
  statusCode: number;
  error: string;
  message: string;
  /** Secondes restantes avant la fin du blocage. */
  retryAfter: number;
}

/**
 * Verrouillage progressif de la connexion, par adresse email visée.
 *
 * Ce que la limitation de débit ne couvre pas : elle compte par IP et par
 * email sur des fenêtres courtes, et un attaquant qui change d'IP à chaque
 * salve reste sous le seuil indéfiniment. Ici, le compteur suit **l'adresse
 * visée** et le blocage double à chaque palier atteint - 60 s, 120 s, 240 s…
 * jusqu'à une heure - ce qui rend le bourrinage sur un compte donné
 * économiquement inintéressant sans jamais gêner un humain qui se trompe deux
 * fois de mot de passe.
 *
 * Deux règles de fond :
 * - **aucun oracle** : un email inconnu est traité exactement comme un mot de
 *   passe faux (même compteur, même blocage, même message). Sinon, la seule
 *   différence de comportement suffirait à énumérer les comptes existants ;
 * - **jamais bloquant en cas de panne** : Redis injoignable, on laisse passer
 *   avec un `warn`. Même politique que `RateLimitTrackerService` - une
 *   protection anti-abus qui tombe ne doit pas emporter l'authentification
 *   avec elle.
 */
@Injectable()
export class LoginLockoutService {
  private readonly logger = new Logger(LoginLockoutService.name);
  private readonly threshold: number;
  private readonly baseSeconds: number;
  private readonly maxSeconds: number;
  private readonly windowSeconds: number;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.threshold =
      configService.get<number>('LOGIN_LOCKOUT_THRESHOLD') ??
      LOGIN_LOCKOUT_DEFAULTS.THRESHOLD;
    this.baseSeconds =
      configService.get<number>('LOGIN_LOCKOUT_BASE_SECONDS') ??
      LOGIN_LOCKOUT_DEFAULTS.BASE_SECONDS;
    this.maxSeconds =
      configService.get<number>('LOGIN_LOCKOUT_MAX_SECONDS') ??
      LOGIN_LOCKOUT_DEFAULTS.MAX_SECONDS;
    this.windowSeconds =
      configService.get<number>('LOGIN_LOCKOUT_WINDOW_SECONDS') ??
      LOGIN_LOCKOUT_DEFAULTS.WINDOW_SECONDS;
  }

  /**
   * Refuse la tentative si l'adresse est actuellement verrouillée.
   *
   * À appeler **avant** toute lecture en base et avant argon2 : le but est
   * précisément de ne plus payer le coût d'une vérification de mot de passe
   * pour un attaquant déjà identifié comme tel.
   */
  async assertNotLocked(email: string): Promise<void> {
    const key = `${LOGIN_LOCKOUT_BLOCK_PREFIX}${hashEmail(email)}`;
    let remaining: number;

    try {
      remaining = await this.redis.ttl(key);
    } catch (error) {
      this.warnUnavailable(error);
      return;
    }

    if (remaining <= 0) {
      return;
    }

    const body: LoginLockedBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      // Même phrase que le garde de limitation de débit : le client ne peut
      // pas distinguer « cette adresse est verrouillée » (donc elle existe
      // peut-être) de « vous allez trop vite ».
      message: TOO_MANY_REQUESTS_MESSAGE,
      retryAfter: remaining,
    };

    throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Enregistre un échec. Au seuil atteint, pose le blocage suivant et remet le
   * compteur à zéro : le palier d'après demandera de nouveau `threshold`
   * échecs, mais coûtera deux fois plus d'attente.
   */
  async recordFailure(email: string): Promise<void> {
    const hash = hashEmail(email);
    const failKey = `${LOGIN_LOCKOUT_FAIL_PREFIX}${hash}`;

    try {
      const failures = await this.redis.incr(failKey);

      if (failures === 1) {
        // La fenêtre part du premier échec : cinq erreurs éparpillées sur la
        // journée ne se cumulent pas.
        await this.redis.expire(failKey, this.windowSeconds);
      }

      if (failures < this.threshold) {
        return;
      }

      const levelKey = `${LOGIN_LOCKOUT_LEVEL_PREFIX}${hash}`;
      const level = await this.redis.incr(levelKey);
      await this.redis.expire(levelKey, LOGIN_LOCKOUT_LEVEL_TTL_SECONDS);

      const blockSeconds = Math.min(
        this.baseSeconds * 2 ** (level - 1),
        this.maxSeconds,
      );

      await this.redis.set(
        `${LOGIN_LOCKOUT_BLOCK_PREFIX}${hash}`,
        '1',
        'EX',
        blockSeconds,
      );
      await this.redis.del(failKey);

      this.logger.warn(
        `Connexion verrouillée · empreinte=${hash.slice(0, 8)}…` +
          ` · palier=${level} · attente=${blockSeconds}s`,
      );
    } catch (error) {
      this.warnUnavailable(error);
    }
  }

  /**
   * Efface compteur et palier après une authentification réussie : seul le
   * titulaire du compte peut faire tomber le verrou, et il le fait sans rien
   * demander à personne.
   */
  async recordSuccess(email: string): Promise<void> {
    const hash = hashEmail(email);

    try {
      await this.redis.del(
        `${LOGIN_LOCKOUT_FAIL_PREFIX}${hash}`,
        `${LOGIN_LOCKOUT_LEVEL_PREFIX}${hash}`,
      );
    } catch (error) {
      this.warnUnavailable(error);
    }
  }

  private warnUnavailable(error: unknown): void {
    this.logger.warn(
      'Verrouillage de connexion indisponible (Redis injoignable) : tentative laissée passer',
      error instanceof Error ? error.stack : String(error),
    );
  }
}

/**
 * Empreinte de l'adresse visée. L'adresse elle-même n'entre jamais dans une
 * clé Redis : une fuite de la base de compteurs ne livrerait pas la liste des
 * comptes attaqués.
 */
function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
