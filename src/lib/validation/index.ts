import { z } from 'zod';
import { ProtocolType, UserRole, UserStatus, ServerStatus, ServerType, TunnelNetwork } from '@prisma/client';

/**
 * Input validation + sanitisation.
 *
 * Every request body is parsed through one of these schemas before it reaches a
 * service. Zod gives us type-safe parsing AND rejects malformed input early,
 * which is our first line of defence against injection and bad data.
 */

/** Strip control characters and trim — applied to all free-text fields. */
export function sanitizeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

/**
 * Build a sanitising string schema.
 *
 * The value is trimmed and stripped of control characters first, then the
 * constraints run on the cleaned value. Constraints live *inside* the pipeline
 * so the resulting type stays a Zod schema (and therefore supports `.optional()`,
 * `.nullable()` and friends).
 */
interface TextOptions {
  min?: number;
  max?: number;
  regex?: RegExp;
  regexMessage?: string;
  minMessage?: string;
}

function sanitizedText(options: TextOptions = {}) {
  const { min = 0, max = 255, regex, regexMessage, minMessage } = options;

  let inner = z.string().max(max, `Must be at most ${max} characters`);
  if (min > 0) inner = inner.min(min, minMessage ?? 'This field is required');
  if (regex) inner = inner.regex(regex, regexMessage);

  return z.string().transform(sanitizeText).pipe(inner);
}

const text = (max = 255) => sanitizedText({ max });

const requiredText = (max = 255, min = 1) => sanitizedText({ min, max });

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be under 128 characters');

const gbToBytes = (gb: number) => BigInt(Math.round(gb * 1024 ** 3));

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

export const loginSchema = z.object({
  /** Accepts either an email address or a username. */
  identifier: requiredText(255),
  password: z.string().min(1, 'Password is required').max(128),
  remember: z.boolean().optional().default(false),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: password,
    confirmPassword: z.string().min(1),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const updateProfileSchema = z.object({
  displayName: text(120).optional(),
  email: z.string().email('A valid email is required').optional(),
});

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

export const createUserSchema = z.object({
  username: sanitizedText({
    min: 3,
    max: 64,
    minMessage: 'Username must be at least 3 characters',
    regex: /^[a-zA-Z0-9._-]+$/,
    regexMessage: 'Username may only contain letters, numbers, dot, underscore and dash',
  }),
  displayName: text(120).optional(),
  email: z.string().email('A valid email is required'),
  password,
  role: z.nativeEnum(UserRole).default(UserRole.USER),
  status: z.nativeEnum(UserStatus).default(UserStatus.ACTIVE),
  notes: text(1000).optional(),
  planId: z.string().cuid().nullable().optional(),
  /** Traffic limit in GB. `null` = unlimited. */
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  expirationDate: z.coerce.date().nullable().optional(),
  expirationDays: z.number().int().positive().nullable().optional(),
});

export const updateUserSchema = z.object({
  displayName: text(120).nullable().optional(),
  email: z.string().email().optional(),
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  notes: text(1000).nullable().optional(),
  planId: z.string().cuid().nullable().optional(),
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  expirationDate: z.coerce.date().nullable().optional(),
  extendDays: z.number().int().positive().optional(),
  resetTraffic: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: password,
  revokeSessions: z.boolean().optional().default(true),
});

export const userQuerySchema = z.object({
  search: z.string().optional(),
  status: z.nativeEnum(UserStatus).optional(),
  role: z.nativeEnum(UserRole).optional(),
  serverId: z.string().optional(),
  sort: z.enum(['createdAt', 'username', 'trafficUsedBytes', 'expirationDate']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// -----------------------------------------------------------------------------
// Servers
// -----------------------------------------------------------------------------

const ipOrHost = z
  .string()
  .transform(sanitizeText)
  .pipe(
    z
      .string()
      .min(1)
      .max(255)
      .regex(
        /^[a-zA-Z0-9._:-]+$/,
        'Enter a valid hostname or IP address (letters, digits, dot, colon, dash, underscore)',
      ),
  );

export const createServerSchema = z.object({
  name: requiredText(120),
  hostname: ipOrHost,
  ipAddress: ipOrHost,
  port: z.coerce.number().int().min(1).max(65535).default(443),
  protocol: z.nativeEnum(ProtocolType).default(ProtocolType.VLESS),
  type: z.nativeEnum(ServerType).default(ServerType.XRAY),
  location: text(120).optional(),
  description: text(1000).optional(),
  monitoringEnabled: z.boolean().default(true),
  agentEndpoint: z.string().url().optional().or(z.literal('')),
  agentToken: z.string().max(512).optional(),
});

export const updateServerSchema = createServerSchema.partial().extend({
  status: z.nativeEnum(ServerStatus).optional(),
});

export const serverQuerySchema = z.object({
  search: z.string().optional(),
  status: z.nativeEnum(ServerStatus).optional(),
  type: z.nativeEnum(ServerType).optional(),
  location: z.string().optional(),
  sort: z.enum(['createdAt', 'name', 'status', 'lastHeartbeat']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// -----------------------------------------------------------------------------
// Configurations
// -----------------------------------------------------------------------------

export const createConfigSchema = z.object({
  name: requiredText(120),
  serverId: z.string().min(1, 'A server must be selected'),
  protocol: z.nativeEnum(ProtocolType),
  /** Single-user ownership. */
  ownerId: z.string().nullable().optional(),
  /** Multi-user assignment — each user receives an independent credential. */
  userIds: z.array(z.string()).optional().default([]),
  /** Protocol-specific parameters; validated again by the generator. */
  params: z.record(z.unknown()),
  remarks: text(500).optional(),
  /**
   * The configuration's OWN allowance. Give either unit; MB wins if both are
   * sent, because it is the more specific entry.
   */
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  trafficLimitMb: z.number().nonnegative().nullable().optional(),
  expirationDays: z.number().int().positive().nullable().optional(),
});

export const updateConfigSchema = z.object({
  name: requiredText(120).optional(),
  params: z.record(z.unknown()).optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'EXPIRED', 'TRAFFIC_EXCEEDED']).optional(),
  remarks: text(500).nullable().optional(),
  regenerateLinks: z.boolean().optional().default(false),
  /** Raise or lower the configuration's own allowance (either unit; MB wins). */
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  trafficLimitMb: z.number().nonnegative().nullable().optional(),
  /** Clear the running total, e.g. after topping the allowance up. */
  resetTraffic: z.boolean().optional(),
});

export const configQuerySchema = z.object({
  search: z.string().optional(),
  serverId: z.string().optional(),
  protocol: z.nativeEnum(ProtocolType).optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'EXPIRED', 'TRAFFIC_EXCEEDED']).optional(),
  userId: z.string().optional(),
  sort: z.enum(['createdAt', 'name', 'type']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const assignConfigSchema = z.object({
  userIds: z.array(z.string()).min(1, 'Select at least one user'),
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  expirationDays: z.number().int().positive().nullable().optional(),
});

// -----------------------------------------------------------------------------
// Tunnels (port forwarding)
// -----------------------------------------------------------------------------

const tunnelPort = z.coerce
  .number()
  .int('Port must be a whole number')
  .min(1, 'Port must be between 1 and 65535')
  .max(65535, 'Port must be between 1 and 65535');

export const createTunnelSchema = z.object({
  name: requiredText(120),
  serverId: z.string().min(1, 'A server must be selected'),
  /** Empty means "every IPv4 interface". */
  listenAddress: ipOrHost.default('0.0.0.0'),
  listenPort: tunnelPort,
  targetHost: ipOrHost,
  targetPort: tunnelPort,
  network: z.nativeEnum(TunnelNetwork).default(TunnelNetwork.TCP),
  enabled: z.boolean().default(true),
  notes: text(500).optional(),
});

/**
 * Updates are a true partial: every field is optional and no default is applied
 * to an omitted field, otherwise a PATCH that only toggles `enabled` would
 * silently reset the network to TCP.
 */
export const updateTunnelSchema = z.object({
  name: requiredText(120).optional(),
  serverId: z.string().min(1).optional(),
  listenAddress: ipOrHost.optional(),
  listenPort: tunnelPort.optional(),
  targetHost: ipOrHost.optional(),
  targetPort: tunnelPort.optional(),
  network: z.nativeEnum(TunnelNetwork).optional(),
  enabled: z.boolean().optional(),
  notes: text(500).nullable().optional(),
});

export const tunnelQuerySchema = z.object({
  search: z.string().optional(),
  serverId: z.string().optional(),
  network: z.nativeEnum(TunnelNetwork).optional(),
  /** Query strings are text; accept only the two values a checkbox can send. */
  enabled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sort: z.enum(['createdAt', 'name', 'listenPort', 'trafficUpBytes']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// -----------------------------------------------------------------------------
// Plans
// -----------------------------------------------------------------------------

export const createPlanSchema = z.object({
  name: requiredText(120),
  description: text(500).optional(),
  priceCents: z.number().int().nonnegative().default(0),
  currency: z.string().length(3).default('USD'),
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  durationDays: z.number().int().positive().default(30),
  deviceLimit: z.number().int().positive().default(1),
  allowedProtocols: z.array(z.nativeEnum(ProtocolType)).default([
    ProtocolType.VLESS,
    ProtocolType.VMESS,
    ProtocolType.TROJAN,
    ProtocolType.SHADOWSOCKS,
  ]),
  allowedServerIds: z.array(z.string()).default([]),
  status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  isDefault: z.boolean().default(false),
});

export const updatePlanSchema = createPlanSchema.partial();

// -----------------------------------------------------------------------------
// Subscriptions / devices
// -----------------------------------------------------------------------------

export const createSubscriptionSchema = z.object({
  userId: z.string().min(1),
  planId: z.string().nullable().optional(),
  serverId: z.string().nullable().optional(),
  quotaType: z.enum(['MONTHLY', 'TOTAL', 'UNLIMITED']).default('TOTAL'),
  trafficLimitGb: z.number().nonnegative().nullable().optional(),
  durationDays: z.number().int().positive().nullable().optional(),
});

export const deviceSchema = z.object({
  name: requiredText(120),
  platform: z.enum(['ANDROID', 'WINDOWS', 'LINUX', 'MACOS', 'IOS', 'OTHER']).default('OTHER'),
  deviceKey: text(255).optional(),
  userAgent: text(500).optional(),
});

// -----------------------------------------------------------------------------
// Traffic / logs / settings
// -----------------------------------------------------------------------------

export const trafficQuerySchema = z.object({
  userId: z.string().optional(),
  serverId: z.string().optional(),
  configId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  granularity: z.enum(['hour', 'day', 'month']).default('day'),
});

export const auditQuerySchema = z.object({
  search: z.string().optional(),
  action: z.string().optional(),
  actorId: z.string().optional(),
  targetType: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const generalSettingsSchema = z.object({
  appName: text(120).optional(),
  logoUrl: z.string().url().nullable().optional(),
  defaultTrafficLimitGb: z.number().nonnegative().nullable().optional(),
  defaultExpirationDays: z.number().int().positive().optional(),
  monitoringIntervalSeconds: z.number().int().min(10).max(3600).optional(),
  trafficWarnPercent: z.number().min(1).max(100).optional(),
  trafficCriticalPercent: z.number().min(1).max(100).optional(),
  notificationEmailEnabled: z.boolean().optional(),
  notificationWebhookUrl: z.string().url().nullable().optional(),
  allowUserSelfService: z.boolean().optional(),
  registrationEnabled: z.boolean().optional(),
});

export const securitySettingsSchema = z.object({
  sessionTimeoutMinutes: z.number().int().min(5).max(10080).optional(),
  passwordMinLength: z.number().int().min(8).max(128).optional(),
  requireMfa: z.boolean().optional(),
  maxLoginAttempts: z.number().int().min(3).max(50).optional(),
  ipAllowlist: z.array(z.string()).optional(),
  forceHttps: z.boolean().optional(),
});

export const updateSettingsSchema = z.object({
  general: generalSettingsSchema.optional(),
  security: securitySettingsSchema.optional(),
  server: z
    .object({
      defaultPort: z.number().int().min(1).max(65535).optional(),
      defaultProtocol: z.nativeEnum(ProtocolType).optional(),
      heartbeatTimeoutSeconds: z.number().int().min(10).max(3600).optional(),
      allowSelfSignedAgent: z.boolean().optional(),
    })
    .optional(),
  traffic: z
    .object({
      countingMode: z.enum(['server', 'config', 'user']).optional(),
      resetPeriod: z.enum(['never', 'monthly', 'custom']).optional(),
      resetDayOfMonth: z.number().int().min(1).max(28).optional(),
      autoSuspendOnExceed: z.boolean().optional(),
    })
    .optional(),
});

export const brandingSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  footerText: text(200).optional(),
  supportUrl: z.string().url().nullable().optional(),
});

export { gbToBytes };
