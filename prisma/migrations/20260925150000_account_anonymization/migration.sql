-- ANON-1 : anonymisation de compte et traitement des comptes inactifs.
-- Strictement additif : une valeur d'enum, trois colonnes nullables et un
-- index. Aucune donnee existante n'est supprimee ni ecrasee ; seule la
-- nouvelle colonne "lastActivityAt" est initialisee (voir plus bas).

-- AlterEnum
ALTER TYPE "AdminActionType" ADD VALUE 'ANONYMIZE_USER';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "inactivityWarningSentAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_lastActivityAt_idx" ON "User"("lastActivityAt");

-- Initialisation de "lastActivityAt" : la plus recente des traces d'activite
-- que la base connait deja, sans jamais descendre sous la date de creation du
-- compte. Les connexions passees ne sont tracees nulle part : a defaut, on
-- retient le dernier envoi client (system = false) et la derniere utilisation
-- d'une cle API ou d'un identifiant SMTP. GREATEST ignore les NULL, donc un
-- compte sans aucune trace retombe sur "createdAt". Idempotent : ne touche
-- que les lignes encore a NULL.
UPDATE "User" u
SET "lastActivityAt" = GREATEST(
  u."createdAt",
  (SELECT MAX(e."queuedAt") FROM "Email" e WHERE e."userId" = u."id" AND e."system" = false),
  (SELECT MAX(k."lastUsedAt") FROM "ApiKey" k WHERE k."userId" = u."id"),
  (SELECT MAX(c."lastUsedAt") FROM "SmtpCredential" c WHERE c."userId" = u."id")
)
WHERE u."lastActivityAt" IS NULL;
