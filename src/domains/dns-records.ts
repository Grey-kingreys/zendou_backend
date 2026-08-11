import {
  DKIM_CNAME_SUFFIX,
  DMARC_RECORD_VALUE,
  SPF_RECORD_VALUE,
} from './domains.constants';

/** Enregistrement DNS à publier chez le registrar du client. */
export interface DnsRecord {
  type: 'CNAME' | 'TXT';
  name: string;
  value: string;
}

/** Enregistrement conseillé (non requis par SES) avec son explication. */
export interface RecommendedDnsRecord extends DnsRecord {
  purpose: 'SPF' | 'DMARC';
  note: string;
}

/**
 * Les 3 CNAME DKIM à copier tels quels : SES vérifie le domaine dès qu'ils
 * répondent.
 */
export function buildDkimRecords(
  domain: string,
  dkimTokens: string[],
): DnsRecord[] {
  return dkimTokens.map((token) => ({
    type: 'CNAME',
    name: `${token}._domainkey.${domain}`,
    value: `${token}.${DKIM_CNAME_SUFFIX}`,
  }));
}

/**
 * SPF et DMARC : facultatifs pour la vérification SES, mais fortement
 * conseillés pour la délivrabilité.
 */
export function buildRecommendedRecords(
  domain: string,
): RecommendedDnsRecord[] {
  return [
    {
      purpose: 'SPF',
      type: 'TXT',
      name: domain,
      value: SPF_RECORD_VALUE,
      note: 'SPF : autorise Amazon SES à envoyer pour ce domaine. Si un enregistrement SPF existe déjà, ne le dupliquez pas — ajoutez « include:amazonses.com » à celui en place.',
    },
    {
      purpose: 'DMARC',
      type: 'TXT',
      name: `_dmarc.${domain}`,
      value: DMARC_RECORD_VALUE,
      note: 'DMARC en mode observation (p=none) : aucun message légitime bloqué. Passez à « p=quarantine » puis « p=reject » une fois vos rapports propres.',
    },
  ];
}
