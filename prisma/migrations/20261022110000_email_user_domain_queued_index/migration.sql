-- CreateIndex
CREATE INDEX "Email_userId_domainId_queuedAt_idx" ON "Email"("userId", "domainId", "queuedAt");
