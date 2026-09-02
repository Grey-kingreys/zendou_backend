import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { RATE_LIMIT_POLICY } from '../rate-limit/rate-limit.constants';
import { RateLimit } from '../rate-limit/rate-limit.decorator';

/**
 * Longueur maximale conservée de chaque valeur journalisée.
 *
 * Une URL de document ou une URI bloquée sont fournies par la page, donc par
 * l'extérieur : sans plafond, n'importe qui pourrait noyer nos journaux sous
 * des chaînes de plusieurs kilo-octets, à raison d'une par rapport.
 */
export const CSP_FIELD_MAX_LENGTH = 200;

/** Nom du journal, volontairement stable : les alertes s'y accrochent. */
export const CSP_REPORT_LOGGER = 'CspReport';

/** Une violation, quel que soit le format dans lequel elle est arrivée. */
interface NormalizedViolation {
  documentUri: string;
  directive: string;
  blockedUri: string;
  disposition: string;
}

/**
 * Réception des rapports de violation de la politique de sécurité de contenu.
 *
 * Sert de boîte aux lettres à la CSP posée sur le **front** : c'est lui qui
 * charge des scripts, donc lui dont une injection se verrait ici. L'API, elle,
 * ne rend que du JSON et interdit tout (`default-src 'none'`).
 *
 * Trois partis pris :
 * - **204, toujours.** Un rapport n'a pas à échouer : un navigateur qui reçoit
 *   une erreur ne réessaie pas, et un corps inattendu ne doit pas produire une
 *   trace d'erreur à chaque chargement de page. Tout ce qui n'est pas une
 *   violation reconnaissable est acquitté en silence. Seule exception, hors
 *   de portée d'ici : un corps qui n'est pas du JSON valide est refusé par le
 *   parseur global (400) avant même que Nest ne route la requête ;
 * - **corps `unknown`.** Le format est dicté par le navigateur, pas par nous :
 *   aucun DTO ne doit pouvoir refuser un rapport parce qu'un champ a bougé
 *   entre deux versions de Chrome ;
 * - **rien de brut au journal.** Une seule ligne par violation, quatre champs,
 *   chacun tronqué. `script-sample` en particulier n'est jamais écrit : il
 *   contient un extrait du script bloqué, donc potentiellement un jeton ou une
 *   donnée personnelle collée dans la page.
 */
@Controller('csp-report')
export class CspReportController {
  private readonly logger = new Logger(CSP_REPORT_LOGGER);

  @Post()
  @RateLimit(RATE_LIMIT_POLICY.CSP_REPORT)
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Body() body: unknown): void {
    for (const violation of normalizeViolations(body)) {
      this.logger.warn(
        `Violation CSP · document=${violation.documentUri}` +
          ` · directive=${violation.directive}` +
          ` · bloque=${violation.blockedUri}` +
          ` · disposition=${violation.disposition}`,
      );
    }
  }
}

/**
 * Accepte les deux formats que les navigateurs emploient aujourd'hui :
 * l'historique `report-uri` (`{ "csp-report": { … } }`, un seul rapport par
 * requête) et la Reporting API `report-to` (un tableau d'enveloppes typées,
 * plusieurs rapports par requête). Tout le reste rend une liste vide, donc un
 * 204 muet.
 */
function normalizeViolations(body: unknown): NormalizedViolation[] {
  if (Array.isArray(body)) {
    return body
      .filter((entry) => isRecord(entry) && entry.type === 'csp-violation')
      .map((entry) => violationOf((entry as Record<string, unknown>).body));
  }

  if (isRecord(body) && isRecord(body['csp-report'])) {
    return [violationOf(body['csp-report'])];
  }

  return [];
}

/**
 * Les deux formats nomment les mêmes informations différemment : le premier
 * nom trouvé gagne.
 */
function violationOf(report: unknown): NormalizedViolation {
  const record = isRecord(report) ? report : {};

  return {
    documentUri: pick(record, 'document-uri', 'documentURL'),
    directive: pick(record, 'violated-directive', 'effectiveDirective'),
    blockedUri: pick(record, 'blocked-uri', 'blockedURL'),
    disposition: pick(record, 'disposition'),
  };
}

/** Valeur du premier champ présent, tronquée ; `?` si aucun ne l'est. */
function pick(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = record[name];

    if (typeof value === 'string' && value.length > 0) {
      return value.slice(0, CSP_FIELD_MAX_LENGTH);
    }
  }

  return '?';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
