import { ConfigService } from '@nestjs/config';
import { parseEmailAddress } from '../emails/email-address';

/**
 * Adresse d'expédition du mode bac à sable (`TEST_EMAIL_FROM`, voir B20 /
 * V11A) sous la forme que le client doit copier dans son champ `from` —
 * l'adresse **nue** (`adresse@domaine`), sans le nom d'affichage éventuel.
 *
 * `TEST_EMAIL_FROM` accepte deux formes (`adresse@domaine` ou
 * `Nom <adresse@domaine>`, voir `env.schema.ts`), mais
 * `EmailsService.isTestSenderAddress` ne compare déjà que la partie adresse
 * pour reconnaître le mode bac à sable (`emails.service.ts`) : le nom
 * d'affichage n'est qu'un habillage cosmétique côté boîte de réception du
 * destinataire, jamais ce qui identifie cette adresse dans ce projet. On
 * expose donc ici la même partie, par cohérence avec cette définition déjà
 * en place — et parce qu'une adresse nue se colle sans risque dans
 * n'importe quel code client (pas de `<`, `>` ni de guillemets à échapper),
 * contrairement à la forme nommée.
 *
 * Réutilise `parseEmailAddress` (`emails/email-address.ts`), déjà la source
 * de vérité unique pour lire cette variable ailleurs dans le projet
 * (`EmailsService`, `env.schema.ts`) : pas de troisième façon de formater
 * une adresse dans ce projet.
 *
 * `null` si `TEST_EMAIL_FROM` est absente ou illisible — jamais d'exception,
 * comme partout ailleurs où cette variable est lue : ce mode est simplement
 * indisponible.
 */
export function resolveTestSenderAddress(
  configService: ConfigService,
): string | null {
  const configured = (
    configService.get<string>('TEST_EMAIL_FROM') ?? ''
  ).trim();

  if (!configured) {
    return null;
  }

  return parseEmailAddress(configured)?.address ?? null;
}
