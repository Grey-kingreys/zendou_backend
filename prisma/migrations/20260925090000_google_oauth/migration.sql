-- B30 "Continuer avec Google". Strictement additif, sans perte de donnees :
-- une colonne nullable et son index unique, et la levee d'une contrainte
-- NOT NULL. Aucune ligne existante n'est modifiee.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleSub" TEXT,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

