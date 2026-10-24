-- Port-forwarding tunnels.
--
-- Xray's `tunnel` protocol (formerly `dokodemo-door`) forwards a public port to
-- a target host without users, credentials or share links. It is modelled
-- separately from `configurations` so the configuration engine, assignment
-- screens and per-user accounting never have to special-case a row that has no
-- clients.

-- CreateEnum
CREATE TYPE "TunnelNetwork" AS ENUM ('TCP', 'UDP', 'TCP_UDP');

-- CreateTable
CREATE TABLE "tunnels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "listenAddress" TEXT NOT NULL DEFAULT '0.0.0.0',
    "listenPort" INTEGER NOT NULL,
    "targetHost" TEXT NOT NULL,
    "targetPort" INTEGER NOT NULL,
    "network" "TunnelNetwork" NOT NULL DEFAULT 'TCP',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "lastError" TEXT,
    "trafficUpBytes" BIGINT NOT NULL DEFAULT 0,
    "trafficDownBytes" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tunnels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tunnels_serverId_listenPort_key" ON "tunnels"("serverId", "listenPort");

-- CreateIndex
CREATE INDEX "tunnels_serverId_idx" ON "tunnels"("serverId");

-- CreateIndex
CREATE INDEX "tunnels_enabled_idx" ON "tunnels"("enabled");

-- AddForeignKey
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
