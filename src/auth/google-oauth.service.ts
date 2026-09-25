import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { SESSION_REDIS } from './auth.constants';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_CLOCK_SKEW_SECONDS,
  GOOGLE_DEFAULT_NEXT,
  GOOGLE_ERROR,
  GOOGLE_ISSUERS,
  GOOGLE_NEXT_MAX_LENGTH,
  GOOGLE_SCOPE,
  GOOGLE_STATE_KEY_PREFIX,
  GOOGLE_STATE_TTL_SECONDS,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_TOKEN_TIMEOUT_MS,
  type GoogleErrorCode,
} from './google-oauth.constants';

/**
 * Échec du parcours Google, porteur du code renvoyé au front
 * (`/connexion?erreur=<code>`). Le message n'est destiné qu'au journal : il ne
 * contient jamais ni `code` d'autorisation, ni jeton, ni secret.
 */
export class GoogleAuthError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Identité Google retenue après validation de l'`id_token`. */
export interface GoogleIdentity {
  /** Identifiant Google stable (claim `sub`). */
  sub: string;
  /** Adresse attestée par Google (`email_verified === true`). */
  email: string;
  /** Claim `name`, `null` s'il est absent. */
  name: string | null;
}

/** État stocké dans Redis entre le départ vers Google et le rappel. */
export interface GoogleOAuthState {
  codeVerifier: string;
  nonce: string;
  next: string;
}

/**
 * Flux « authorization code » d'OpenID Connect avec PKCE (S256), `state` et
 * `nonce`, sans dépendance (B30, même ligne que `libmime` plutôt que
 * `mailparser`).
 *
 * L'état vit dans Redis (client des sessions), sous une clé dérivée du
 * `state`, 10 minutes, à usage unique. Le navigateur, lui, porte le `state`
 * dans le cookie court `zendou_oauth` : le rappel n'est accepté que si les
 * deux concordent.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly redirectUri: string | undefined;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.clientId = configService.get<string>('GOOGLE_CLIENT_ID');
    this.clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET');
    this.redirectUri = configService.get<string>('GOOGLE_REDIRECT_URI');
  }

  /**
   * La fonction n'est active que si les trois variables sont présentes
   * (`env.schema.ts` impose déjà « les trois ou aucune »).
   */
  isEnabled(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /**
   * Prépare le départ vers Google : tire `state`, `nonce` et `code_verifier`,
   * stocke l'état, et rend l'URL d'autorisation et le `state` à poser en
   * cookie.
   */
  async start(
    next: unknown,
  ): Promise<{ state: string; authorizationUrl: string }> {
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();
    const stored: GoogleOAuthState = {
      codeVerifier,
      nonce,
      next: sanitizeNext(next),
    };

    await this.redis.set(
      stateKey(state),
      JSON.stringify(stored),
      'EX',
      GOOGLE_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: this.redirectUri ?? '',
      response_type: 'code',
      scope: GOOGLE_SCOPE,
      state,
      nonce,
      code_challenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    return {
      state,
      authorizationUrl: `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
    };
  }

  /**
   * Lit **et supprime** l'état en une seule opération atomique (MULTI) :
   * un rappel rejoué, ou deux rappels simultanés, n'en voient qu'un passer.
   * `null` si l'état est absent, expiré, déjà consommé ou illisible.
   */
  async consumeState(state: string): Promise<GoogleOAuthState | null> {
    const key = stateKey(state);
    const results = await this.redis.multi().get(key).del(key).exec();
    const raw = results?.[0]?.[1];

    if (typeof raw !== 'string') {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      if (
        isRecord(parsed) &&
        typeof parsed.codeVerifier === 'string' &&
        typeof parsed.nonce === 'string' &&
        typeof parsed.next === 'string'
      ) {
        return {
          codeVerifier: parsed.codeVerifier,
          nonce: parsed.nonce,
          next: sanitizeNext(parsed.next),
        };
      }
    } catch {
      // Valeur illisible : traitée comme un état absent.
    }

    return null;
  }

  /**
   * Échange le `code` contre l'`id_token` (avec le `code_verifier` PKCE),
   * puis valide ses claims. Lève `GoogleAuthError` en cas d'échec.
   */
  async fetchIdentity(
    code: string,
    stored: GoogleOAuthState,
  ): Promise<GoogleIdentity> {
    const idToken = await this.exchangeCode(code, stored.codeVerifier);

    return validateIdTokenClaims(decodeIdTokenPayload(idToken), {
      clientId: this.clientId ?? '',
      nonce: stored.nonce,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
  }

  private async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<string> {
    let response: Response;

    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.clientId ?? '',
          client_secret: this.clientSecret ?? '',
          redirect_uri: this.redirectUri ?? '',
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      // Nom de l'erreur seulement (`TimeoutError`, `TypeError`…) : jamais le
      // corps de la requête, qui contient le code et le secret.
      throw new GoogleAuthError(
        GOOGLE_ERROR.UNAVAILABLE,
        `échange de jeton Google injoignable (${error instanceof Error ? error.name : 'erreur inconnue'})`,
      );
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      // Le champ `error` de Google (`invalid_grant`…) est un code public,
      // sans secret : utile au diagnostic, sûr à journaliser.
      const googleError =
        isRecord(body) && typeof body.error === 'string'
          ? ` (${body.error.slice(0, 64)})`
          : '';
      throw new GoogleAuthError(
        GOOGLE_ERROR.UNAVAILABLE,
        `échange de jeton Google refusé : statut ${response.status}${googleError}`,
      );
    }

    if (!isRecord(body) || typeof body.id_token !== 'string') {
      throw new GoogleAuthError(
        GOOGLE_ERROR.UNAVAILABLE,
        'réponse de jeton Google illisible (id_token absent)',
      );
    }

    return body.id_token;
  }

  /** Trace un échec du parcours, sans rien de secret (voir `GoogleAuthError`). */
  logFailure(error: GoogleAuthError): void {
    this.logger.warn(
      `Connexion Google refusée [${error.code}] : ${error.message}`,
    );
  }
}

/**
 * Décode la charge utile de l'`id_token` **sans vérifier sa signature**.
 *
 * Justification (OpenID Connect Core 1.0, §3.1.3.7, point 6) : quand l'ID
 * Token est reçu **directement** de l'endpoint de jeton, par une communication
 * TLS entre le client et le fournisseur, la validation du serveur TLS peut
 * remplacer celle de la signature. C'est exactement notre cas :
 * `exchangeCode` l'obtient en réponse à notre propre `POST` vers
 * `https://oauth2.googleapis.com/token`, authentifié par notre secret client
 * et lié à la requête d'origine par PKCE. Aucun jeton venu du navigateur n'est
 * jamais décodé ici.
 *
 * Les autres contrôles restent obligatoires et sont faits par
 * `validateIdTokenClaims` : `iss`, `aud`, `exp`, `nonce`, `sub`, `email`,
 * `email_verified === true`.
 */
export function decodeIdTokenPayload(idToken: string): unknown {
  const parts = idToken.split('.');

  if (parts.length !== 3) {
    throw new GoogleAuthError(
      GOOGLE_ERROR.UNAVAILABLE,
      'id_token mal formé (3 segments attendus)',
    );
  }

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleAuthError(
      GOOGLE_ERROR.UNAVAILABLE,
      'id_token illisible (charge utile non JSON)',
    );
  }
}

/**
 * Contrôles obligatoires des claims de l'`id_token` (B30).
 *
 * `email_verified` doit valoir le **booléen** `true` : sans ce contrôle, un
 * compte fédéré portant une adresse non vérifiée contournerait la
 * confirmation d'adresse, et pourrait se rattacher au compte d'autrui.
 */
export function validateIdTokenClaims(
  payload: unknown,
  expected: { clientId: string; nonce: string; nowSeconds: number },
): GoogleIdentity {
  const fail = (
    reason: string,
    code: GoogleErrorCode = GOOGLE_ERROR.UNAVAILABLE,
  ) => new GoogleAuthError(code, `id_token refusé : ${reason}`);

  if (!isRecord(payload)) {
    throw fail('charge utile absente');
  }

  if (
    typeof payload.iss !== 'string' ||
    !GOOGLE_ISSUERS.includes(payload.iss)
  ) {
    throw fail('émetteur (iss) inattendu');
  }

  if (payload.aud !== expected.clientId || expected.clientId === '') {
    throw fail('audience (aud) inattendue');
  }

  if (
    typeof payload.exp !== 'number' ||
    payload.exp + GOOGLE_CLOCK_SKEW_SECONDS <= expected.nowSeconds
  ) {
    throw fail('jeton expiré (exp)');
  }

  // Le `nonce` lie le jeton à l'état de CE navigateur : un jeton émis pour un
  // autre parcours est un état qui ne correspond pas.
  if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce) {
    throw fail('nonce différent', GOOGLE_ERROR.SESSION_EXPIRED);
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw fail('sub absent');
  }

  if (typeof payload.email !== 'string' || payload.email.length === 0) {
    throw fail('email absent');
  }

  if (payload.email_verified !== true) {
    throw fail(
      'adresse non vérifiée par Google',
      GOOGLE_ERROR.EMAIL_NOT_VERIFIED,
    );
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}

/**
 * Destination après connexion : un chemin **relatif** commençant par `/`, ni
 * `//` ni `/\` (que les navigateurs lisent comme une URL sans schéma vers un
 * autre hôte), sans caractère de contrôle. Tout le reste retombe sur
 * `/dashboard`. Aucun validateur équivalent n'existait côté backend.
 */
export function sanitizeNext(next: unknown): string {
  if (
    typeof next !== 'string' ||
    next.length === 0 ||
    next.length > GOOGLE_NEXT_MAX_LENGTH ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.startsWith('/\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(next)
  ) {
    return GOOGLE_DEFAULT_NEXT;
  }

  return next;
}

/** Comparaison à temps constant de deux `state` (cookie et requête). */
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function stateKey(state: string): string {
  return `${GOOGLE_STATE_KEY_PREFIX}${createHash('sha256').update(state).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
