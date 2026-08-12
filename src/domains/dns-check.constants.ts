/**
 * Plages IPv4 publiées par Cloudflare (https://www.cloudflare.com/ips-v4/).
 *
 * Sert uniquement à nommer l'erreur « proxy Cloudflare activé » (nuage
 * orange) quand un CNAME DKIM répond par une adresse A au lieu du CNAME
 * attendu. Liste stable dans le temps mais non garantie exhaustive : une
 * IP absente de cette liste ne prouve pas l'absence de proxy, elle fait
 * simplement retomber le diagnostic sur l'aplatissement CNAME générique
 * (`cname_aplati`), qui reste correct dans les deux cas.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

/** Messages associés aux diagnostics ciblés (DKIM uniquement). */
export const DNS_CHECK_DIAGNOSTIC_MESSAGE = {
  PROXY_CLOUDFLARE:
    "Le nuage Cloudflare (proxy) est activé sur cet enregistrement : il répond par une adresse IP Cloudflare au lieu du CNAME attendu. Désactivez le proxy (nuage gris) sur ce sous-domaine « _domainkey » — Amazon SES a besoin du CNAME brut, pas d'un proxy devant.",
  DOMAINE_DUPLIQUE:
    "L'enregistrement existe, mais sous un nom où le domaine apparaît deux fois (souvent parce que le registrar ajoute déjà le domaine au champ « Nom » et que la valeur complète y a été recollée). Supprimez le nom de domaine du champ « Nom » chez votre registrar et ne laissez que la partie qui précède.",
  CNAME_APLATI:
    "Le champ répond par une adresse IP au lieu d'un CNAME : cet hébergeur DNS aplatit (« flatten ») l'enregistrement au lieu de le publier tel quel. Amazon SES a besoin d'un vrai CNAME — vérifiez si votre hébergeur propose un mode « CNAME strict » ou changez de fournisseur DNS pour ce domaine.",
} as const;
