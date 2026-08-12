-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "system" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailVerificationSentTo" TEXT,
ADD COLUMN     "emailVerificationTokenHash" TEXT,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "welcomeCreditsGrantedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_emailVerificationTokenHash_key" ON "User"("emailVerificationTokenHash");

-- Rétro-confirmation des comptes existants.
--
-- Sans cette ligne, tous les comptes déjà en base sortiraient de la migration
-- avec `emailVerifiedAt` à NULL, donc « non confirmés » : ils perdraient d'un
-- coup le droit d'envoyer et de créer une clé API, alors qu'ils n'ont jamais
-- eu la possibilité de confirmer quoi que ce soit — la fonctionnalité
-- n'existait pas. Ce serait une régression provoquée par nous, sur des
-- clients en production (domaine vérifié, historique d'envois, clés en
-- service). La règle « confirmer avant d'envoyer » ne vaut donc que pour les
-- comptes créés **après** cette migration.
--
-- `createdAt` plutôt que `now()` : la rétro-confirmation reste reconnaissable
-- (`emailVerifiedAt = createdAt` à la microseconde près ⇔ compte
-- rétro-confirmé), et l'on n'invente pas une cohorte de comptes portant tous
-- le même horodatage. Le crédit de bienvenue n'est **pas** accordé ici : il
-- est lié au geste de confirmation, que ces comptes n'ont pas fait ; un admin
-- peut toujours l'accorder à la main (`GRANT_CREDITS`).
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;
