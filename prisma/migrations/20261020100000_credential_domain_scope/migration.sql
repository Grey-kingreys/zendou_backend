-- CreateEnum
CREATE TYPE "CredentialDomainScope" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "domainScope" "CredentialDomainScope" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "SmtpCredential" ADD COLUMN     "domainScope" "CredentialDomainScope" NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "ApiKeyDomain" (
    "apiKeyId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyDomain_pkey" PRIMARY KEY ("apiKeyId","domainId")
);

-- CreateTable
CREATE TABLE "SmtpCredentialDomain" (
    "smtpCredentialId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,

    CONSTRAINT "SmtpCredentialDomain_pkey" PRIMARY KEY ("smtpCredentialId","domainId")
);

-- CreateIndex
CREATE INDEX "ApiKeyDomain_domainId_idx" ON "ApiKeyDomain"("domainId");

-- CreateIndex
CREATE INDEX "SmtpCredentialDomain_domainId_idx" ON "SmtpCredentialDomain"("domainId");

-- AddForeignKey
ALTER TABLE "ApiKeyDomain" ADD CONSTRAINT "ApiKeyDomain_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyDomain" ADD CONSTRAINT "ApiKeyDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpCredentialDomain" ADD CONSTRAINT "SmtpCredentialDomain_smtpCredentialId_fkey" FOREIGN KEY ("smtpCredentialId") REFERENCES "SmtpCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpCredentialDomain" ADD CONSTRAINT "SmtpCredentialDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

