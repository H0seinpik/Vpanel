# =============================================================================
# VPanel — multi-stage Dockerfile
#
# Targets:
#   web     → minimal Next.js standalone server (default)
#   worker  → background job runner (traffic collection, monitoring, enforcement)
#
# Build:  docker build --target web -t vpanel-web .
#         docker build --target worker -t vpanel-worker .
# =============================================================================

# --- Base ---------------------------------------------------------------------
FROM node:20-alpine AS base
# Prisma needs OpenSSL; libc6-compat keeps Alpine glibc-compatible.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# --- Dependencies -------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, otherwise fall back to install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# --- Builder ------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# A dummy DATABASE_URL lets `prisma generate` run without a live database.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npx prisma generate && npm run build

# --- Web runtime --------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next.js standalone output bundles the server and its runtime dependencies.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma schema + migrations + engine, needed by `prisma migrate deploy`.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma

COPY --chown=nextjs:nodejs docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "server.js"]

# --- Worker runtime -----------------------------------------------------------
# The worker runs TypeScript directly through tsx, so it needs the full
# dependency tree (including devDependencies) and the source tree.
FROM base AS worker
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 worker

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=worker:nodejs package.json tsconfig.json ./
COPY --chown=worker:nodejs prisma ./prisma
COPY --chown=worker:nodejs src ./src
COPY --chown=worker:nodejs workers ./workers

RUN npx prisma generate && chown -R worker:nodejs /app

USER worker
CMD ["npx", "tsx", "workers/index.ts", "daemon"]
