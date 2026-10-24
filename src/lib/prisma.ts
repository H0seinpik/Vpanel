import { PrismaClient } from '@prisma/client';

/**
 * Prisma is instantiated once per process. In development Next.js hot-reloads
 * modules, so we cache the client on `globalThis` to avoid exhausting the
 * connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
