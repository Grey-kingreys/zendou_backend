/**
 * Masquage des secrets destinés à une trace.
 *
 * **À utiliser pour TOUTE trace mentionnant une clé API, un mot de passe SMTP
 * ou un jeton**, y compris un journal de niveau `debug` : un journal se
 * recopie, s'exporte et se colle dans un ticket, et un secret qui y figure en
 * clair est un secret compromis.
 *
 * Aucune trace actuelle n'en a besoin - l'audit du code a confirmé qu'aucune
 * n'écrit de secret aujourd'hui. Ce helper existe pour que la règle soit
 * outillée le jour où quelqu'un ajoute la ligne de journal qui, sans lui,
 * écrirait la clé entière.
 */

/** Ce qui remplace la partie masquée, quelle que soit la longueur d'origine. */
const MASK = '****';

/**
 * Rend une forme reconnaissable mais inexploitable d'un secret :
 * `zd_live_cle_secrete_1234` devient `zd_live_****1234`.
 *
 * Le préfixe conservé sert au diagnostic (il porte l'environnement de la clé,
 * `zd_live_` ou `zd_test_`), les quatre derniers caractères permettent au
 * porteur de reconnaître *sa* clé dans une liste sans que personne ne puisse
 * la rejouer.
 *
 * Une valeur trop courte pour que ce découpage laisse quoi que ce soit de
 * caché est masquée **entièrement** : sur un secret de 10 caractères, garder
 * 8 + 4 en révélerait la totalité.
 */
export function maskSecret(
  value: string,
  visiblePrefix = 8,
  visibleSuffix = 4,
): string {
  if (value.length <= visiblePrefix + visibleSuffix) {
    return MASK;
  }

  return `${value.slice(0, visiblePrefix)}${MASK}${value.slice(-visibleSuffix)}`;
}
