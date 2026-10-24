import { z } from 'zod';

/**
 * Environment schema. Everything the app needs is declared here and validated
 * once at boot. No secret is ever hard-coded — values come from `.env` or the
 * container environment (see `.env.example`).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_NAME: z.string().min(1).default('VPanel'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),

  /**
   * Whether auth cookies get the `Secure` flag.
   *
   * `auto` (default) sets it only when APP_URL is https, so a panel served over
   * plain HTTP on a trusted LAN still works. Browsers reject `Secure` cookies
   * sent over http:// on anything other than localhost, which would make login
   * fail silently.
   */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

  REDIS_URL: z.string().optional().or(z.literal('')),

  ENABLE_INLINE_WORKER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  TRAFFIC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),
  WORKER_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(90),

  DEFAULT_TRAFFIC_LIMIT_GB: z.coerce.number().positive().default(100),
  DEFAULT_EXPIRATION_DAYS: z.coerce.number().int().positive().default(30),
  DEFAULT_SESSION_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),
  DEFAULT_TRAFFIC_WARN_PERCENT: z.coerce.number().min(1).max(100).default(80),

  /**
   * Which backend serves the registered nodes.
   *
   *   local  - no outbound calls; traffic and metrics are SIMULATED. For dev.
   *   xray   - a local Xray instance; real traffic read from its stats API.
   *   agent  - HTTPS to each node's agent.
   */
  NODE_PROVIDER: z.enum(['local', 'agent', 'xray']).default('local'),

  // --- Local Xray supervisor -------------------------------------------------
  /** Enable the Xray supervisor (config rendering + process control). */
  XRAY_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Where Xray lives. The config is written to `<XRAY_DIR>/config.json`. */
  XRAY_DIR: z.string().default('C:\\xray'),
  /** Loopback port for Xray's gRPC stats API. Never exposed publicly. */
  XRAY_API_PORT: z.coerce.number().int().positive().default(10085),
  /** Re-apply the node config automatically when it drifts from the database. */
  XRAY_AUTO_SYNC: z.enum(['true', 'false']).default('true'),
  /**
   * TLS certificate used by TLS-requiring inbounds (Trojan, VLESS+TLS).
   *
   * Empty = `<XRAY_DIR>\cert.pem` / `<XRAY_DIR>\key.pem`, which is where
   * `install-xray.bat` puts a generated self-signed pair. Without a certificate
   * a TLS inbound cannot serve at all, so those configurations are reported as
   * skipped rather than silently failing to connect.
   */
  XRAY_CERT_FILE: z.string().default(''),
  XRAY_KEY_FILE: z.string().default(''),
  AGENT_SHARED_SECRET: z.string().optional().or(z.literal('')),

  SMTP_URL: z.string().optional().or(z.literal('')),
  MAIL_FROM: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional().or(z.literal('')),
  TELEGRAM_CHAT_ID: z.string().optional().or(z.literal('')),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Returns the validated environment. In `test` mode missing secrets fall back to
 * deterministic throwaway values so unit tests never need a real `.env`.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const raw: NodeJS.ProcessEnv = { ...process.env };

  if (raw.NODE_ENV === 'test') {
    raw.JWT_ACCESS_SECRET ||= 'test-access-secret-that-is-long-enough-000000';
    raw.JWT_REFRESH_SECRET ||= 'test-refresh-secret-that-is-long-enough-11111';
    raw.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

export const isProd = () => getEnv().NODE_ENV === 'production';
export const isTest = () => getEnv().NODE_ENV === 'test';

/**
 * Drop the memoised environment so the next `getEnv()` re-reads `process.env`.
 * Test seam only — the application never needs to do this at runtime.
 */
export function resetEnvCache(): void {
  cached = null;
}
