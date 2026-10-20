import { BadRequestException } from '@nestjs/common';
import { CredentialDomainScope, DomainStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** Refus 400 d'une sélection de domaines inutilisable (B27). */
export const CREDENTIAL_DOMAINS_INVALID_MESSAGE =
  'Chaque domaine sélectionné doit exister dans votre compte et être vérifié.';

/** Refus 400 d'une sélection qui nomme deux fois le même domaine (B27). */
export const CREDENTIAL_DOMAINS_DUPLICATE_MESSAGE =
  "Un domaine ne peut être sélectionné qu'une seule fois.";

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
