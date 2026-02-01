-- Add DO Spaces credentials to Environment for backups
ALTER TABLE "Environment" ADD COLUMN "spacesAccessKey" TEXT;
ALTER TABLE "Environment" ADD COLUMN "encryptedSpacesSecret" TEXT;
ALTER TABLE "Environment" ADD COLUMN "spacesSecretNonce" TEXT;
ALTER TABLE "Environment" ADD COLUMN "spacesRegion" TEXT;
ALTER TABLE "Environment" ADD COLUMN "spacesEndpoint" TEXT;
