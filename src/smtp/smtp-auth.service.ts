import { timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretHashingService } from '../api-keys';
import { AUTH_USER_SELECT, resolveTestSenderAddress } from '../auth';
import { PrismaService } from '../prisma/prisma.service';
import { smtpReplyToError } from './smtp-reply.adapter';
import { SMTP_REPLY_AUTH_INVALID_CREDENTIALS } from './smtp-reply';
import type { SmtpSessionUser } from './smtp-session';

/**
 * Authentification `AUTH PLAIN` / `AUTH LOGIN` du relais SMTP (§3.3 du plan
 * B6).
 *
 * Ce service interroge Prisma directement, sur le modèle d'`ApiKeyAuthGuard` :
 * l'authentification d'un canal n'a pas sa place dans le module de gestion du
 * cycle de vie des identifiants (S4), qui expose une API REST de création /
 * révocation / rotation et n'a aucune raison de connaître une session SMTP.
 * Les deux modules partagent ce qui doit l'être — le hachage
 * (`hashSmtpCredentialSecret`) et la sélection d'utilisateur
 * (`AUTH_USER_SELECT`) — et rien d'autre.
 */
@Injectable()
export class SmtpAuthService {
  private readonly logger = new Logger(SmtpAuthService.name);

  /**
   * Hachage des secrets, poivre compris (E3) - la même mécanique que celle des
   * clés API, puisque c'est le même genre de secret porteur.
   *
   * Construit ici plutôt qu'injecté : `SmtpRelayModule` ne connaît que
   * `EmailsCoreModule`, et lui faire importer `ApiKeysModule` (contrôleur REST
   * compris) pour une classe sans état dont la seule dépendance est
   * `ConfigService` couterait plus qu'il ne rapporte. Le service reste
   * fourni par `ApiKeysModule` pour tout ce qui vit dans le graphe HTTP.
   */
  private readonly secretHashing: SecretHashingService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.secretHashing = new SecretHashingService(configService);
  }

  /**
   * Vérifie un couple (nom d'utilisateur, secret) et rend l'utilisateur à
   * attacher à la session.
   *
   * Lève `SMTP_REPLY_AUTH_INVALID_CREDENTIALS` — **la même constante, donc le
   * même code et le même texte** — dans les quatre cas de refus : identifiants
   * incomplets, nom d'utilisateur inconnu, identifiant révoqué, secret faux.
   * Le §3.3 l'exige pour ne donner aucun oracle d'énumération : distinguer
   * « inconnu » de « mauvais mot de passe » révélerait quels noms
   * d'utilisateur existent.
   *
   * Un compte **suspendu authentifie normalement** : ses identifiants sont
   * valides, et un refus ici serait un message trompeur. Le refus tombe au
   * `MAIL FROM` (`550 5.7.1`, hors périmètre S5) — parallèle exact du 403
   * d'`ApiKeyAuthGuard`. Aucun contrôle de `UserStatus` ne doit donc apparaître
   * dans cette méthode.
   */
  async authenticate(
    username: string | undefined,
    secret: string | undefined,
    remoteAddress: string,
  ): Promise<SmtpSessionUser> {
    if (!username || !secret) {
      this.refuse(username, remoteAddress, 'identifiants incomplets');
    }

    const credential = await this.prisma.smtpCredential.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        secretHash: true,
        revokedAt: true,
        user: { select: AUTH_USER_SELECT },
      },
    });

    if (!credential) {
      this.refuse(username, remoteAddress, 'nom d’utilisateur inconnu');
    }

    if (credential.revokedAt) {
      this.refuse(username, remoteAddress, 'identifiant révoqué');
    }

    if (
      !secretMatches(
        this.secretHashing.candidateHashes(secret),
        credential.secretHash,
      )
    ) {
      this.refuse(username, remoteAddress, 'secret invalide');
    }

    // Migration paresseuse (E3), exactement comme `ApiKeyAuthGuard` : le
    // secret vient d'être reconnu sous son empreinte historique, on la
    // réécrit poivrée. Attendue - sans quoi la migration ne se ferait jamais
    // -, mais tolérante à l'échec : une base en lecture seule ne doit pas
    // faire échouer une authentification par ailleurs valide.
    if (this.secretHashing.isLegacy(credential.secretHash, secret)) {
      try {
        await this.prisma.smtpCredential.update({
          where: { id: credential.id },
          data: { secretHash: this.secretHashing.hashForStorage(secret) },
        });
      } catch (error: unknown) {
        this.logger.warn(
          `Échec de la migration de l'empreinte de l'identifiant SMTP ${credential.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    // Fire-and-forget, comme `ApiKeyAuthGuard` : la mise à jour d'un horodatage
    // d'usage ne doit jamais retarder — ni faire échouer — une session SMTP.
    void this.prisma.smtpCredential
      .update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Échec de la mise à jour de lastUsedAt pour l'identifiant SMTP ${credential.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      });

    return {
      credentialId: credential.id,
      username: credential.username,
      // `testSenderAddress` n'est pas une colonne Prisma : même complément que
      // dans `ApiKeyAuthGuard`, pour ne pas laisser circuler un `AuthUser`
      // structurellement incomplet (S7 s'en servira pour le bac à sable).
      user: {
        ...credential.user,
        testSenderAddress: resolveTestSenderAddress(this.configService),
      },
    };
  }

  /**
   * Journalise l'échec puis lève le refus unique. Le motif n'est écrit **que**
   * dans nos journaux : il ne franchit jamais la frontière du réseau, où seul
   * le texte indifférencié de la constante est renvoyé.
   *
   * §5 : « les échecs d'AUTH loguent IP + nom d'utilisateur, jamais le mot de
   * passe présenté » — le secret n'est passé à aucune méthode de ce chemin.
   */
  private refuse(
    username: string | undefined,
    remoteAddress: string,
    reason: string,
  ): never {
    this.logger.warn(
      `Authentification SMTP refusée depuis ${remoteAddress} pour « ${username ?? '(absent)'} » : ${reason}`,
    );

    throw smtpReplyToError(SMTP_REPLY_AUTH_INVALID_CREDENTIALS);
  }
}

/**
 * Compare les empreintes possibles du secret présenté à celle stockée, en
 * temps constant.
 *
 * `ApiKeyAuthGuard` n'a pas besoin d'équivalent : il retrouve la clé **par**
 * son empreinte, sans jamais comparer deux secrets. Ici le nom d'utilisateur
 * mène à la ligne et la comparaison est explicite, donc faite comme il se
 * doit. Les longueurs sont vérifiées d'abord : `timingSafeEqual` lève sur des
 * tampons de tailles différentes, ce qu'une empreinte tronquée en base
 * suffirait à provoquer.
 *
 * Plusieurs candidats depuis E3 (forme poivrée, puis forme historique) : la
 * boucle les parcourt tous sans sortir au premier succès, pour que le temps
 * de réponse ne dise pas sous quelle forme le secret a été reconnu.
 */
function secretMatches(candidates: string[], expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  let matched = false;

  for (const candidate of candidates) {
    const presented = Buffer.from(candidate, 'hex');

    if (
      presented.length > 0 &&
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      matched = true;
    }
  }

  return matched;
}
