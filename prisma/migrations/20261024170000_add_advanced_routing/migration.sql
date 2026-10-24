-- CreateEnum
CREATE TYPE "ReverseProxyRole" AS ENUM ('BRIDGE', 'PORTAL');

-- CreateTable
CREATE TABLE "inbounds" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'vless',
    "listen" TEXT NOT NULL DEFAULT '0.0.0.0',
    "port" INTEGER NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "streamSettings" JSONB NOT NULL DEFAULT '{}',
    "sniffing" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbounds" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'freedom',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "streamSettings" JSONB NOT NULL DEFAULT '{}',
    "sendThrough" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "remarks" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "outboundTag" TEXT,
    "balancerTag" TEXT,
    "inboundTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "domain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "port" TEXT,
    "sourceIp" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourcePort" TEXT,
    "protocol" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "network" TEXT,
    "remarks" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reverse_proxies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "role" "ReverseProxyRole" NOT NULL,
    "tag" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "remarks" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reverse_proxies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbounds_serverId_enabled_idx" ON "inbounds"("serverId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "inbounds_serverId_tag_key" ON "inbounds"("serverId", "tag");

-- CreateIndex
CREATE INDEX "outbounds_serverId_enabled_idx" ON "outbounds"("serverId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "outbounds_serverId_tag_key" ON "outbounds"("serverId", "tag");

-- CreateIndex
CREATE INDEX "routing_rules_serverId_enabled_sortOrder_idx" ON "routing_rules"("serverId", "enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "reverse_proxies_serverId_role_idx" ON "reverse_proxies"("serverId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "reverse_proxies_serverId_tag_key" ON "reverse_proxies"("serverId", "tag");

-- AddForeignKey
ALTER TABLE "inbounds" ADD CONSTRAINT "inbounds_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbounds" ADD CONSTRAINT "outbounds_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reverse_proxies" ADD CONSTRAINT "reverse_proxies_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

