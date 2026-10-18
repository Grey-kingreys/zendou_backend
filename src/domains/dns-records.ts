import {
  DKIM_CNAME_SUFFIX,
  DMARC_RECORD_VALUE,
  MAIL_FROM_MX_PRIORITY,
  SPF_RECORD_VALUE,
  mailFromDomainOf,
  mailFromMxHost,
} from './domains.constants';

/** Enregistrement DNS à publier chez le registrar du client. */
export interface DnsRecord {
  type: 'CNAME' | 'TXT' | 'MX';
  name: string;
  value: string;
  /** Priorité, pour un enregistrement MX seulement. */
  priority?: number;
}

/** Enregistrement conseillé (non requis par SES) avec son explication. */
export interface RecommendedDnsRecord extends DnsRecord {
  purpose: 'MX' | 'SPF' | 'DMARC';
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
 * MAIL FROM personnalisé (MX et SPF sur `bounce.<domaine>`) et DMARC :
 * facultatifs pour la vérification SES, mais fortement conseillés pour la
 * délivrabilité. Le SPF se publie sur le sous-domaine `bounce`, plus sur le
 * domaine racine. `region` est la région SES configurée (`AWS_REGION`).
 */
export function buildRecommendedRecords(
  domain: string,
  region: string,
): RecommendedDnsRecord[] {
  const mailFrom = mailFromDomainOf(domain);

  return [
    {
      purpose: 'MX',
      type: 'MX',
      name: mailFrom,
      value: mailFromMxHost(region),
      priority: MAIL_FROM_MX_PRIORITY,
      note: `MAIL FROM personnalisé (1/2) : cet enregistrement MX, de priorité ${MAIL_FROM_MX_PRIORITY}, permet à Amazon SES de recevoir les retours d'erreur sur « ${mailFrom} ». Vos messages sont alors alignés sur votre propre domaine, ce qui améliore la délivrabilité. Si vous ne l'ajoutez pas, rien ne casse : Amazon SES utilise son adresse d'enveloppe par défaut.`,
    },
    {
      purpose: 'SPF',
      type: 'TXT',
      name: mailFrom,
      value: SPF_RECORD_VALUE,
      note: `MAIL FROM personnalisé (2/2) : SPF de « ${mailFrom} », qui autorise Amazon SES à envoyer pour ce sous-domaine. Il remplace l'ancien SPF du domaine racine : vous n'avez plus besoin d'ajouter « include:amazonses.com » au SPF de « ${domain} », que vous pouvez laisser tel quel pour vos autres services.`,
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
