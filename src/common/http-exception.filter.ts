import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'http';
import type { Response } from 'express';

/**
 * Phrase du 500 générique — une exception qui n'est pas une `HttpException`,
 * c'est-à-dire un bug serveur dont rien ne doit filtrer.
 *
 * Reprend **mot pour mot** le message que Nest renvoie aujourd'hui pour une
 * exception non gérée : le corps d'un 500 reste ainsi identique à l'existant,
 * `errors` mis à part. Ce n'est volontairement pas une nouvelle formule
 * produit — la seule phrase qu'un client verra ici est celle qu'il voyait
 * déjà.
 *
 * **Ne sert de repli que pour un vrai 500.** Tout autre statut sans phrase
 * exploitable prend la sienne (voir {@link fallbackMessage}) : écrire
 * « erreur interne » à côté d'un diagnostic juste — le 503 de `/health`, qui
 * dit précisément quel maillon est tombé — enverrait l'ops sur une fausse
 * piste.
 */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * Corps d'erreur normalisé — le contrat que **toutes** les routes rendent.
 *
 * - `message` est **toujours** une chaîne : la phrase à afficher ;
 * - `errors` est **toujours** un tableau de chaînes non vide : le détail
 *   granulaire, un élément par champ invalide ;
 * - invariant : `message === errors.join(' ')`.
 *
 * `statusCode`, `error` et tout autre champ déjà présent dans le corps
 * d'origine sont conservés tels quels.
 */
export interface NormalizedErrorBody extends Record<string, unknown> {
  statusCode: number;
  message: string;
  errors: string[];
}

/**
 * Uniformise le corps de **toutes** les réponses d'erreur HTTP.
 *
 * Le bug qu'il corrige : `message` changeait de type selon le chemin d'échec.
 * Le `ValidationPipe` global agrège les violations de class-validator en
 * **tableau** ; un `throw new BadRequestException("…")` écrit dans le service
 * produit une **chaîne**. Comme certains messages sont volontairement partagés
 * entre le DTO et le service (`INVALID_TO_MESSAGE`), deux requêtes invalides
 * pouvaient rendre le même 400, la même phrase métier, sous deux formes — et
 * un client qui lisait `data["message"][0]` récupérait la phrase entière dans
 * un cas, la lettre « L » dans l'autre.
 *
 * Le filtre ne touche ni aux statuts, ni aux phrases métier : il ne fait que
 * ranger, et n'est donc **jamais** un endroit où une règle d'envoi se décide.
 *
 * Deux points de vigilance, tenus par construction :
 * - il ne **mute jamais** l'exception ni l'objet rendu par `getResponse()` —
 *   le corps est toujours reconstruit par copie. Le motif `SEND_REFUSAL` que
 *   `EmailsService.accept()` pose sur l'exception, et que `smtpReplyForError`
 *   lit côté serveur pour le relais SMTP, survit donc intact ;
 * - il ne s'exécute que sur une exception : une réponse 2xx, 204 comprise, ne
 *   passe pas par ici.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = normalizeErrorBody(exception, status);

      setRetryAfter(response, status, body);

      response.status(status).json(body);
      return;
    }

    // Bug serveur : la vraie erreur — message et pile — part au journal, et
    // seulement au journal. Le client reçoit un 500 générique, sans un mot de
    // l'interne.
    this.logger.error(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: INTERNAL_ERROR_MESSAGE,
      errors: [INTERNAL_ERROR_MESSAGE],
    } satisfies NormalizedErrorBody);
  }
}

/**
 * Pose `Retry-After` sur tout 429 dont le corps annonce un délai d'attente.
 *
 * Le garde de limitation de débit le pose déjà lui-même, sur la réponse, avant
 * de lever son exception : cette fonction est donc idempotente pour lui (même
 * valeur, tirée du même corps). Elle sert aux **429 métier** - quota journalier
 * dépassé, connexion verrouillée - levés depuis un service, qui n'ont aucun
 * accès à la réponse HTTP et ne peuvent donc écrire qu'un `retryAfter` dans le
 * corps. Sans cet en-tête, un client HTTP standard n'a aucun moyen de savoir
 * quand réessayer.
 *
 * Aucune conversion : la valeur du corps est déjà exprimée en secondes, comme
 * l'en-tête. Une valeur absente, nulle ou non numérique ne pose rien.
 */
function setRetryAfter(
  response: Response,
  status: number,
  body: NormalizedErrorBody,
): void {
  if (status !== TOO_MANY_REQUESTS_STATUS) {
    return;
  }

  const retryAfter = body.retryAfter;

  if (
    typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0
  ) {
    response.setHeader('Retry-After', String(Math.ceil(retryAfter)));
  }
}

/**
 * Reconstruit le corps d'une `HttpException` au format normalisé.
 *
 * Travaille sur une **copie** du corps d'origine : `getResponse()` rend
 * l'objet porté par l'exception elle-même quand elle a été construite avec un
 * objet (`HealthController`, `RateLimitGuard`), et le muter reviendrait à
 * réécrire l'exception que d'autres appelants — le relais SMTP — inspectent
 * ensuite.
 */
function normalizeErrorBody(
  exception: HttpException,
  status: number,
): NormalizedErrorBody {
  const payload = exception.getResponse();

  // Un corps déjà objet est repris champ pour champ : `error`, `retryAfter`,
  // le détail de `/health`… rien ne se perd. Un corps chaîne ou tableau est
  // le `message` lui-même — c'est ce qu'en fait Nest par défaut.
  const source: Record<string, unknown> = isRecord(payload)
    ? { ...payload }
    : { statusCode: status, message: payload };

  const errors = messagesOf(source.message, status);

  // L'ordre des clés d'origine est préservé : réaffecter une clé déjà présente
  // ne la déplace pas. `errors` s'ajoute donc en fin de corps.
  return {
    ...source,
    statusCode:
      typeof source.statusCode === 'number' ? source.statusCode : status,
    message: errors.join(' '),
    errors,
  };
}

/**
 * Extrait la liste des phrases d'un `message` de forme quelconque : chaîne
 * (throw manuel), tableau (agrégat du `ValidationPipe`), ou rien du tout.
 *
 * Rend toujours un tableau non vide : c'est la moitié du contrat.
 */
function messagesOf(raw: unknown, status: number): string[] {
  const candidates =
    typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string')
        : [];

  // Le `trim` garantit l'invariant `message === errors.join(' ')` : une phrase
  // à espace de bord rendrait le rejointoiement non idempotent.
  const kept = candidates
    .map((message) => message.trim())
    .filter((message) => message.length > 0);

  return kept.length > 0 ? kept : [fallbackMessage(status)];
}

/**
 * Phrase de repli d'une `HttpException` dont le corps ne porte aucun message.
 *
 * Le seul cas réel aujourd'hui est `HealthController`, qui lève
 * `new HttpException(result, 503)` où `result` est le diagnostic lui-même
 * (`{ status, db, redis, smtp }`) — un objet sans champ `message`. Le corps
 * dit déjà précisément quel maillon est tombé ; y coller « Internal server
 * error » inventerait une panne serveur là où l'information exacte est juste
 * à côté, et enverrait l'ops chercher au mauvais endroit.
 *
 * On prend donc la phrase normalisée du code HTTP — « Service Unavailable »
 * pour 503. Source : `http.STATUS_CODES` de Node, c'est-à-dire le registre
 * IANA des codes d'état tel que la plateforme le livre. Aucune dépendance
 * nouvelle, aucune table à maintenir, et c'est déjà ce qu'Express écrit dans
 * la ligne de statut de la même réponse : le corps et l'en-tête disent enfin
 * la même chose.
 *
 * Exception faite du 500, qui garde la formulation de Nest
 * ({@link INTERNAL_ERROR_MESSAGE}, « Internal server error » — minuscule à
 * « server ») pour que le corps d'un vrai 500 reste identique à l'existant.
 */
function fallbackMessage(status: number): string {
  if (status === INTERNAL_SERVER_ERROR_STATUS) {
    return INTERNAL_ERROR_MESSAGE;
  }

  return STATUS_CODES[status] ?? INTERNAL_ERROR_MESSAGE;
}

/**
 * `HttpStatus` est un enum, `HttpException.getStatus()` rend un `number` nu :
 * on élargit une fois ici plutôt que de comparer deux types disjoints.
 */
const INTERNAL_SERVER_ERROR_STATUS: number = HttpStatus.INTERNAL_SERVER_ERROR;

/** Même élargissement, pour la comparaison du 429 (voir {@link setRetryAfter}). */
const TOO_MANY_REQUESTS_STATUS: number = HttpStatus.TOO_MANY_REQUESTS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
