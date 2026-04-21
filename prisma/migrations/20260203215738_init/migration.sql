-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "lastActiveAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sshPrivateKey" TEXT,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "allowSecretReveal" BOOLEAN NOT NULL DEFAULT true,
    "allowBackupDownload" BOOLEAN NOT NULL DEFAULT false,
    "spacesAccessKey" TEXT,
    "encryptedSpacesSecret" TEXT,
    "spacesSecretNonce" TEXT,
    "spacesRegion" TEXT,
    "spacesEndpoint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "schedulerConfig" TEXT
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "publicIp" TEXT,
    "tags" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "metricsMode" TEXT NOT NULL DEFAULT 'disabled',
    "agentToken" TEXT,
    "agentStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastAgentPushAt" DATETIME,
    "agentVersion" TEXT,
    "agentStatusChangedAt" DATETIME,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Server_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServerMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cpuPercent" REAL,
    "memoryUsedMb" REAL,
    "memoryTotalMb" REAL,
    "diskUsedGb" REAL,
    "diskTotalGb" REAL,
    "loadAvg1" REAL,
    "loadAvg5" REAL,
    "loadAvg15" REAL,
    "uptime" INTEGER,
    "source" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serverId" TEXT NOT NULL,
    CONSTRAINT "ServerMetrics_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL DEFAULT 'latest',
    "composePath" TEXT,
    "composeTemplate" TEXT,
    "healthCheckUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "containerStatus" TEXT NOT NULL DEFAULT 'unknown',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "exposedPorts" TEXT,
    "discoveryStatus" TEXT NOT NULL DEFAULT 'found',
    "lastCheckedAt" DATETIME,
    "lastDiscoveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "healthWaitMs" INTEGER NOT NULL DEFAULT 30000,
    "healthRetries" INTEGER NOT NULL DEFAULT 3,
    "healthIntervalMs" INTEGER NOT NULL DEFAULT 5000,
    "agentHealthSuccess" BOOLEAN,
    "agentHealthStatusCode" INTEGER,
    "agentHealthDurationMs" INTEGER,
    "agentHealthCheckedAt" DATETIME,
    "serverId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "containerImageId" TEXT NOT NULL,
    CONSTRAINT "Service_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Service_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Service_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cpuPercent" REAL,
    "memoryUsedMb" REAL,
    "memoryLimitMb" REAL,
    "networkRxMb" REAL,
    "networkTxMb" REAL,
    "blockReadMb" REAL,
    "blockWriteMb" REAL,
    "restartCount" INTEGER,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serviceId" TEXT NOT NULL,
    CONSTRAINT "ServiceMetrics_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageTag" TEXT NOT NULL,
    "previousTag" TEXT,
    "status" TEXT NOT NULL,
    "logs" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT,
    "containerImageHistoryId" TEXT,
    CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deployment_containerImageHistoryId_fkey" FOREIGN KEY ("containerImageHistoryId") REFERENCES "ContainerImageHistory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "description" TEXT,
    "neverReveal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Secret_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConfigFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "isBinary" BOOLEAN NOT NULL DEFAULT false,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "ConfigFile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetPath" TEXT NOT NULL,
    "lastSyncedAt" DATETIME,
    "serviceId" TEXT NOT NULL,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "ServiceFile_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceFile_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deploymentId" TEXT NOT NULL,
    CONSTRAINT "DeploymentArtifact_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "details" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "environmentId" TEXT,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "editedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedById" TEXT,
    "configFileId" TEXT,
    CONSTRAINT "FileHistory_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileHistory_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RegistryConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "registryUrl" TEXT NOT NULL,
    "repositoryPrefix" TEXT,
    "encryptedToken" TEXT,
    "tokenNonce" TEXT,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "passwordNonce" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "refreshIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "autoLinkPattern" TEXT,
    "lastRefreshAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "RegistryConnection_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Database" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "encryptedCredentials" TEXT,
    "credentialsNonce" TEXT,
    "filePath" TEXT,
    "backupStorageType" TEXT NOT NULL DEFAULT 'local',
    "backupLocalPath" TEXT,
    "backupSpacesBucket" TEXT,
    "backupSpacesPrefix" TEXT,
    "backupFormat" TEXT NOT NULL DEFAULT 'plain',
    "backupCompression" TEXT NOT NULL DEFAULT 'none',
    "backupCompressionLevel" INTEGER NOT NULL DEFAULT 6,
    "pgDumpOptions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "serverId" TEXT,
    CONSTRAINT "Database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Database_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatabaseBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "storageType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "databaseId" TEXT NOT NULL,
    "triggeredById" TEXT,
    CONSTRAINT "DatabaseBackup_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatabaseBackup_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackupSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cronExpression" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "databaseId" TEXT NOT NULL,
    CONSTRAINT "BackupSchedule_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceDatabase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionEnvVar" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    CONSTRAINT "ServiceDatabase_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceDatabase_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template" TEXT NOT NULL,
    "defaultChannels" TEXT NOT NULL DEFAULT '["in_app"]',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "bounceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bounceThreshold" INTEGER NOT NULL DEFAULT 3,
    "bounceCooldown" INTEGER NOT NULL DEFAULT 900,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "typeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" TEXT,
    "environmentId" TEXT,
    "inAppReadAt" DATETIME,
    "emailSentAt" DATETIME,
    "webhookSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "NotificationType" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT true,
    "environmentIds" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationPreference_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "NotificationType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SmtpConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 587,
    "secure" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "passwordNonce" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL DEFAULT 'BRIDGEPORT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "encryptedSecret" TEXT,
    "secretNonce" TEXT,
    "headers" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "typeFilter" TEXT,
    "environmentIds" TEXT,
    "lastTriggeredAt" DATETIME,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BounceTracker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "alertSentAt" DATETIME
);

-- CreateTable
CREATE TABLE "ContainerImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "currentTag" TEXT NOT NULL,
    "latestTag" TEXT,
    "latestDigest" TEXT,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "registryConnectionId" TEXT,
    CONSTRAINT "ContainerImage_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContainerImage_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContainerImageHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "digest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployedBy" TEXT,
    "containerImageId" TEXT NOT NULL,
    CONSTRAINT "ContainerImageHistory_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    CONSTRAINT "ServiceDependency_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "imageTag" TEXT,
    "triggerType" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "autoRollback" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "logs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT NOT NULL,
    "containerImageId" TEXT,
    "userId" TEXT,
    CONSTRAINT "DeploymentPlan_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentPlanStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "action" TEXT NOT NULL,
    "targetTag" TEXT,
    "previousTag" TEXT,
    "healthPassed" BOOLEAN,
    "healthDetails" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "logs" TEXT,
    "deploymentPlanId" TEXT NOT NULL,
    "serviceId" TEXT,
    "deploymentId" TEXT,
    CONSTRAINT "DeploymentPlanStep_deploymentPlanId_fkey" FOREIGN KEY ("deploymentPlanId") REFERENCES "DeploymentPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlanStep_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlanStep_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "sshCommandTimeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "sshReadyTimeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "webhookMaxRetries" INTEGER NOT NULL DEFAULT 3,
    "webhookTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "webhookRetryDelaysMs" TEXT NOT NULL DEFAULT '[1000,5000,15000]',
    "pgDumpTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "maxUploadSizeMb" INTEGER NOT NULL DEFAULT 50,
    "activeUserWindowMin" INTEGER NOT NULL DEFAULT 15,
    "registryMaxTags" INTEGER NOT NULL DEFAULT 50,
    "defaultLogLines" INTEGER NOT NULL DEFAULT 50,
    "agentCallbackUrl" TEXT,
    "agentStaleThresholdMs" INTEGER NOT NULL DEFAULT 180000,
    "agentOfflineThresholdMs" INTEGER NOT NULL DEFAULT 300000,
    "doRegistryToken" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ServiceType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ServiceTypeCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "serviceTypeId" TEXT NOT NULL,
    CONSTRAINT "ServiceTypeCommand_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpacesConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accessKey" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "secretKeyNonce" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SpacesEnvironment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "spacesConfigId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "SpacesEnvironment_spacesConfigId_fkey" FOREIGN KEY ("spacesConfigId") REFERENCES "SpacesConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HealthCheckLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "httpStatus" INTEGER,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HealthCheckLog_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Server_environmentId_name_key" ON "Server"("environmentId", "name");

-- CreateIndex
CREATE INDEX "ServerMetrics_serverId_collectedAt_idx" ON "ServerMetrics"("serverId", "collectedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Service_serverId_name_key" ON "Service"("serverId", "name");

-- CreateIndex
CREATE INDEX "ServiceMetrics_serviceId_collectedAt_idx" ON "ServiceMetrics"("serviceId", "collectedAt" DESC);

-- CreateIndex
CREATE INDEX "Deployment_serviceId_startedAt_idx" ON "Deployment"("serviceId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Secret_environmentId_key_key" ON "Secret"("environmentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigFile_environmentId_name_key" ON "ConfigFile"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceFile_serviceId_configFileId_key" ON "ServiceFile"("serviceId", "configFileId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_environmentId_idx" ON "AuditLog"("environmentId");

-- CreateIndex
CREATE INDEX "FileHistory_configFileId_editedAt_idx" ON "FileHistory"("configFileId", "editedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RegistryConnection_environmentId_name_key" ON "RegistryConnection"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Database_environmentId_name_key" ON "Database"("environmentId", "name");

-- CreateIndex
CREATE INDEX "DatabaseBackup_databaseId_createdAt_idx" ON "DatabaseBackup"("databaseId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BackupSchedule_databaseId_key" ON "BackupSchedule"("databaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceDatabase_serviceId_databaseId_key" ON "ServiceDatabase"("serviceId", "databaseId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationType_code_key" ON "NotificationType"("code");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_inAppReadAt_idx" ON "Notification"("userId", "inAppReadAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_typeId_key" ON "NotificationPreference"("userId", "typeId");

-- CreateIndex
CREATE UNIQUE INDEX "BounceTracker_resourceType_resourceId_eventType_key" ON "BounceTracker"("resourceType", "resourceId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerImage_environmentId_imageName_key" ON "ContainerImage"("environmentId", "imageName");

-- CreateIndex
CREATE INDEX "ContainerImageHistory_containerImageId_deployedAt_idx" ON "ContainerImageHistory"("containerImageId", "deployedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceDependency_dependentId_dependsOnId_key" ON "ServiceDependency"("dependentId", "dependsOnId");

-- CreateIndex
CREATE INDEX "DeploymentPlan_environmentId_createdAt_idx" ON "DeploymentPlan"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DeploymentPlanStep_deploymentPlanId_order_idx" ON "DeploymentPlanStep"("deploymentPlanId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceType_name_key" ON "ServiceType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTypeCommand_serviceTypeId_name_key" ON "ServiceTypeCommand"("serviceTypeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SpacesEnvironment_spacesConfigId_environmentId_key" ON "SpacesEnvironment"("spacesConfigId", "environmentId");

-- CreateIndex
CREATE INDEX "HealthCheckLog_environmentId_createdAt_idx" ON "HealthCheckLog"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "HealthCheckLog_resourceId_createdAt_idx" ON "HealthCheckLog"("resourceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "HealthCheckLog_status_createdAt_idx" ON "HealthCheckLog"("status", "createdAt" DESC);
