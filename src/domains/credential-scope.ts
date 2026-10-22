import { BadRequestException } from '@nestjs/common';
import { CredentialDomainScope, DomainStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** Refus 400 d'une sélection de domaines inutilisable (B27). */
export const CREDENTIAL_DOMAINS_INVALID_MESSAGE =
  'Chaque domaine sélectionné doit exister dans votre compte et être vérifié.';

/** Refus 400 d'une sélection qui nomme deux fois le même domaine (B27). */
export const CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE =
  "Un domaine ne peut être sélectionné qu'une seule fois.";

/**
 * Un domaine sélectionné a disparu entre le contrôle et l'écriture (supprimé en
 * même temps) : violation de clé étrangère (P2003), traduite en 400.
 */
export function translateScopeWriteError(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003'
  ) {
    return new BadRequestException(CREDENTIAL_DOMAINS_INVALID_MESSAGE);
  }

  return error;
}

/** Domaine lié à une clé ou à un identifiant, tel qu'exposé en lecture. */
export interface ScopeDomain {
  id: string;
  name: string;
}

/** Portée exposée en lecture sur les clés API et les identifiants SMTP. */
export interface CredentialScopeView {
  domainScope: CredentialDomainScope;
  domains: ScopeDomain[];
}

/**
 * Valide `domainIds` (corps de création) et rend la portée à écrire.
 *
 * Absent ou vide = `ALL` (comportement historique). Sinon `SELECTED`, et
 * chaque identifiant doit désigner un domaine du compte **vérifié** : un
 * domaine d'un autre compte, inexistant ou non vérifié donne le même 400, pour
 * ne pas servir d'oracle sur les domaines des autres comptes.
 */
export async function resolveCredentialScope(
  prisma: PrismaService,
  userId: string,
  domainIds: string[] | undefined,
): Promise<{ domainScope: CredentialDomainScope; domainIds: string[] }> {
  if (!domainIds || domainIds.length === 0) {
    return { domainScope: CredentialDomainScope.ALL, domainIds: [] };
  }

  if (new Set(domainIds).size !== domainIds.length) {
    throw new BadRequestException(CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE);
  }

  const found = await prisma.domain.count({
    where: { id: { in: domainIds }, userId, status: DomainStatus.VERIFIED },
  });

  if (found !== domainIds.length) {
    throw new BadRequestException(CREDENTIAL_DOMAINS_INVALID_MESSAGE);
  }

  return { domainScope: CredentialDomainScope.SELECTED, domainIds };
}

/**
 * Colonnes de portée lues avec une clé ou un identifiant : la colonne
 * `domainScope` et les domaines liés. Les deux tables de jointure
 * (`ApiKeyDomain`, `SmtpCredentialDomain`) exposent la même relation `domain`,
 * donc le même `select` sert aux deux.
 */
export const SCOPE_SELECT = {
  domainScope: true,
  domains: {
    select: { domain: { select: { id: true, name: true } } },
    orderBy: { domain: { name: 'asc' } },
  },
} as const;

/** Aplatit les lignes de jointure en `{ id, name }`. */
export function toScopeDomains(
  links: { domain: ScopeDomain }[],
): ScopeDomain[] {
  return links.map((link) => ({ id: link.domain.id, name: link.domain.name }));
}

/**
 * Domaines qu'une clé API peut LIRE (journal des envois, domaines), selon sa
 * portée B27. `null` : aucune restriction (session, ou clé `ALL`). Sinon la
 * liste des identifiants de domaines autorisés, vide comprise : une portée
 * `SELECTED` sans domaine ne voit rien, et une clé introuvable non plus
 * (fail-closed). Comme à l'envoi, la portée se lit sur la colonne
 * `domainScope`, jamais sur la présence de lignes de jointure.
 */
export async function resolveReadScope(
  prisma: PrismaService,
  apiKeyId: string | undefined,
): Promise<string[] | null> {
  if (apiKeyId === undefined) {
    return null;
  }

  const found = await prisma.apiKey.findUnique({
    where: { id: apiKeyId },
    select: { domainScope: true, domains: { select: { domainId: true } } },
  });

  if (found?.domainScope === CredentialDomainScope.ALL) {
    return null;
  }

  return found?.domains.map((link) => link.domainId) ?? [];
}
