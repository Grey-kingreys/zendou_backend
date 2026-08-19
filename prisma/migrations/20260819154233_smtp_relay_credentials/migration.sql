-- CreateEnum
CREATE TYPE "EmailChannel" AS ENUM ('API', 'SMTP');

-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "channel" "EmailChannel" NOT NULL DEFAULT 'API',
ADD COLUMN     "smtpCredentialId" TEXT;

-- CreateTable
CREATE TABLE "SmtpCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmtpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmtpCredential_username_key" ON "SmtpCredential"("username");

-- CreateIndex
CREATE UNIQUE INDEX "SmtpCredential_secretHash_key" ON "SmtpCredential"("secretHash");

-- CreateIndex
CREATE INDEX "SmtpCredential_userId_idx" ON "SmtpCredential"("userId");

-- AddForeignKey
ALTER TABLE "SmtpCredential" ADD CONSTRAINT "SmtpCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_smtpCredentialId_fkey" FOREIGN KEY ("smtpCredentialId") REFERENCES "SmtpCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
