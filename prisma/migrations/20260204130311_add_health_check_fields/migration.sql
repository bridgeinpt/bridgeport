-- AlterTable
ALTER TABLE "Service" ADD COLUMN "agentCertCheckResults" TEXT;
ALTER TABLE "Service" ADD COLUMN "agentCertCheckedAt" DATETIME;
ALTER TABLE "Service" ADD COLUMN "agentTcpCheckResults" TEXT;
ALTER TABLE "Service" ADD COLUMN "agentTcpCheckedAt" DATETIME;
ALTER TABLE "Service" ADD COLUMN "certChecks" TEXT;
ALTER TABLE "Service" ADD COLUMN "tcpChecks" TEXT;
