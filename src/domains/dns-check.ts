import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises';
import type { DomainStatus } from '@prisma/client';
import {
  CLOUDFLARE_IPV4_RANGES,
  DNS_CHECK_DIAGNOSTIC_MESSAGE,
} from './dns-check.constants';
import {
  DKIM_CNAME_SUFFIX,
  DMARC_RECORD_VALUE,
  SPF_RECORD_VALUE,
} from './domains.constants';

/**
 * Diagnostic DNS des enregistrements DKIM/SPF/DMARC, calculé côté Zendou par
 * résolution DNS directe — **indépendant de SES**.
 *
 * Important : ce diagnostic est **informatif**. SES reste seul juge du
 * statut réel d'un domaine (`Domain.status` en base, mis à jour par
 * `DomainsService.check`). Les deux peuvent diverger légitimement : nos 3
 * enregistrements peuvent être trouvés corrects ici alors que SES n'a pas
 * encore refait son propre contrôle (cache DNS, latence de propagation, essai
 * périodique côté AWS). Rien ici ne doit être traité comme un remplacement du
 * statut SES — seulement comme une explication de ce qui bloque, le cas
 * échéant.
 */

/** Verdict d'un enregistrement DNS unique. */
export type DnsRecordStatus = 'ok' | 'introuvable' | 'valeur_differente';

/** Diagnostics ciblés — DKIM uniquement, les erreurs les plus fréquentes. */
export type DkimDiagnostic =
  'proxy_cloudflare' | 'domaine_duplique' | 'cname_aplati';

/** Résultat de la vérification d'un des 3 CNAME DKIM. */
export interface DkimRecordCheck {
  token: string;
  /** Nom interrogé : `<token>._domainkey.<domaine>`. */
  name: string;
  status: DnsRecordStatus;
  /** Valeur attendue : `<token>.dkim.amazonses.com`. */
  attendu: string;
  /** Valeur trouvée (CNAME ou IP selon le cas), `null` si rien trouvé. */
  trouve: string | null;
  /** TTL en secondes constaté sur la réponse, quand disponible. */
  ttl: number | null;
  /** Erreur classique nommée, seulement quand elle s'applique. */
  diagnostic?: DkimDiagnostic;
  /** Explication en français du diagnostic ciblé, pour affichage direct. */
  message?: string;
}

/** Résultat de la vérification SPF ou DMARC (un enregistrement TXT). */
export interface TxtRecordCheck {
  name: string;
  status: DnsRecordStatus;
  attendu: string;
  trouve: string | null;
  ttl: number | null;
}

/** Diagnostic complet d'un domaine. */
export interface DomainDnsCheckResult {
  domainId: string;
  domainName: string;
  /** Horodatage de ce contrôle (pas celui du dernier contrôle SES). */
  checkedAt: Date;
  /**
   * Dernier statut connu côté SES (lu en base, aucun appel SES déclenché par
   * cet endpoint). Sert au frontend à distinguer « enregistrements corrects,
   * en attente de la validation d'Amazon » d'une vraie erreur.
   */
  sesStatus: DomainStatus;
  dkim: DkimRecordCheck[];
  spf: TxtRecordCheck;
  dmarc: TxtRecordCheck;
}

/** Normalise une valeur DNS pour comparaison : casse et point final ignorés. */
export function normalizeDnsValue(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function dnsValuesMatch(a: string, b: string): boolean {
  return normalizeDnsValue(a) === normalizeDnsValue(b);
}

/** `true` pour les erreurs DNS signifiant « rien de ce type à ce nom ». */
function isNotFoundDnsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const match = IPV4_PATTERN.exec(ip);

  if (!match) {
    return null;
  }

  const octets = match.slice(1).map(Number);

  if (octets.some((octet) => octet > 255)) {
    return null;
  }

  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixLengthRaw] = cidr.split('/');
  const prefixLength = Number(prefixLengthRaw);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangeIp);

  if (ipInt === null || rangeInt === null) {
    return false;
  }

  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;

  return (ipInt & mask) === (rangeInt & mask);
}

/** `true` si l'IPv4 donnée appartient à une plage Cloudflare connue. */
export function isCloudflareIp(ip: string): boolean {
  return CLOUDFLARE_IPV4_RANGES.some((cidr) => isIpInCidr(ip, cidr));
}

/**
 * Vérifie un des 3 CNAME DKIM et nomme les erreurs classiques :
 * proxy Cloudflare, domaine dupliqué, aplatissement CNAME.
 */
async function checkDkimToken(
  domainName: string,
  token: string,
): Promise<DkimRecordCheck> {
  const name = `${token}._domainkey.${domainName}`;
  const attendu = `${token}.${DKIM_CNAME_SUFFIX}`;

  try {
    const cnames = await resolveCname(name);
    const trouve = cnames[0] ?? null;

    if (trouve && dnsValuesMatch(trouve, attendu)) {
      return { token, name, status: 'ok', attendu, trouve, ttl: null };
    }

    return {
      token,
      name,
      status: 'valeur_differente',
      attendu,
      trouve,
      ttl: null,
    };
  } catch (error) {
    if (!isNotFoundDnsError(error)) {
      return {
        token,
        name,
        status: 'introuvable',
        attendu,
        trouve: null,
        ttl: null,
      };
    }

    // Domaine dupliqué : le registrar a déjà ajouté <domaine> au champ
    // « Nom » et le client a recollé le nom complet, donnant
    // <token>._domainkey.<domaine>.<domaine>. On sonde ce nom précis avant
    // de renoncer.
    const duplicatedName = `${name}.${domainName}`;

    try {
      const duplicatedCnames = await resolveCname(duplicatedName);
      const duplicatedValue = duplicatedCnames[0];

      if (duplicatedValue && dnsValuesMatch(duplicatedValue, attendu)) {
        return {
          token,
          name,
          status: 'introuvable',
          attendu,
          trouve: null,
          ttl: null,
          diagnostic: 'domaine_duplique',
          message: `${DNS_CHECK_DIAGNOSTIC_MESSAGE.DOMAINE_DUPLIQUE} (trouvé à « ${duplicatedName} » au lieu de « ${name} »)`,
        };
      }
    } catch {
      // Rien à ce nom dupliqué non plus : on retombe sur les vérifications
      // suivantes puis, en dernier recours, sur « introuvable ».
    }

    // Proxy Cloudflare / aplatissement CNAME : le champ répond par une
    // adresse A au lieu du CNAME demandé.
    try {
      const aRecords = await resolve4(name, { ttl: true });

      if (aRecords.length > 0) {
        const addresses = aRecords.map((record) => record.address);
        const cloudflare = addresses.some((address) => isCloudflareIp(address));

        return {
          token,
          name,
          status: 'valeur_differente',
          attendu,
          trouve: addresses.join(', '),
          ttl: aRecords[0].ttl ?? null,
          diagnostic: cloudflare ? 'proxy_cloudflare' : 'cname_aplati',
          message: cloudflare
            ? DNS_CHECK_DIAGNOSTIC_MESSAGE.PROXY_CLOUDFLARE
            : DNS_CHECK_DIAGNOSTIC_MESSAGE.CNAME_APLATI,
        };
      }
    } catch {
      // Pas d'enregistrement A non plus : vraiment introuvable.
    }

    return {
      token,
      name,
      status: 'introuvable',
      attendu,
      trouve: null,
      ttl: null,
    };
  }
}

/** Vérifie la présence de `include:amazonses.com` dans le SPF du domaine. */
async function checkSpf(domainName: string): Promise<TxtRecordCheck> {
  const name = domainName;

  try {
    const txtRecords = await resolveTxt(name);
    const values = txtRecords.map((parts) => parts.join(''));
    const spfValues = values.filter((value) =>
      normalizeDnsValue(value).startsWith('v=spf1'),
    );
    const matching = spfValues.find((value) =>
      normalizeDnsValue(value).includes('include:amazonses.com'),
    );

    if (matching) {
      return {
        name,
        status: 'ok',
        attendu: SPF_RECORD_VALUE,
        trouve: matching,
        ttl: null,
      };
    }

    if (spfValues.length > 0) {
      return {
        name,
        status: 'valeur_differente',
        attendu: SPF_RECORD_VALUE,
        trouve: spfValues.join(' | '),
        ttl: null,
      };
    }

    return {
      name,
      status: 'introuvable',
      attendu: SPF_RECORD_VALUE,
      trouve: null,
      ttl: null,
    };
  } catch {
    // Absence confirmée (ENOTFOUND/ENODATA) ou erreur réseau (timeout,
    // SERVFAIL) : dans les deux cas on ne peut pas confirmer la présence de
    // l'enregistrement, donc « introuvable » plutôt qu'un crash de tout le
    // diagnostic pour une seule résolution flaky.
    return {
      name,
      status: 'introuvable',
      attendu: SPF_RECORD_VALUE,
      trouve: null,
      ttl: null,
    };
  }
}

/** Vérifie la présence d'un enregistrement DMARC à `_dmarc.<domaine>`. */
async function checkDmarc(domainName: string): Promise<TxtRecordCheck> {
  const name = `_dmarc.${domainName}`;
  const attendu = DMARC_RECORD_VALUE;

  try {
    const txtRecords = await resolveTxt(name);
    const values = txtRecords.map((parts) => parts.join(''));
    const dmarcValues = values.filter((value) =>
      normalizeDnsValue(value).startsWith('v=dmarc1'),
    );

    if (dmarcValues.length > 0) {
      return {
        name,
        status: 'ok',
        attendu,
        trouve: dmarcValues.join(' | '),
        ttl: null,
      };
    }

    return { name, status: 'introuvable', attendu, trouve: null, ttl: null };
  } catch {
    // Cf. checkSpf : absence confirmée ou erreur réseau, même verdict.
    return { name, status: 'introuvable', attendu, trouve: null, ttl: null };
  }
}

/**
 * Diagnostic DNS complet d'un domaine : les 3 CNAME DKIM, le SPF et le
 * DMARC. Ne touche jamais SES — uniquement des résolutions DNS directes.
 */
export async function checkDomainDns(domain: {
  id: string;
  name: string;
  dkimTokens: string[];
  status: DomainStatus;
}): Promise<DomainDnsCheckResult> {
  const [dkim, spf, dmarc] = await Promise.all([
    Promise.all(
      domain.dkimTokens.map((token) => checkDkimToken(domain.name, token)),
    ),
    checkSpf(domain.name),
    checkDmarc(domain.name),
  ]);

  return {
    domainId: domain.id,
    domainName: domain.name,
    checkedAt: new Date(),
    sesStatus: domain.status,
    dkim,
    spf,
    dmarc,
  };
}
