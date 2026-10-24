import { prisma } from '@/lib/prisma';
import { getEnv } from '@/lib/env';
import { recordAudit, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * System settings.
 *
 * Defaults live in code so the app boots with zero configuration; the database
 * only stores values an administrator has explicitly changed. Reads merge the
 * two, so adding a new setting never requires a migration of existing rows.
 */

export type SettingsCategory = 'general' | 'security' | 'server' | 'traffic' | 'branding';

export interface GeneralSettings {
  appName: string;
  logoUrl: string | null;
  defaultTrafficLimitGb: number | null;
  defaultExpirationDays: number;
  monitoringIntervalSeconds: number;
  trafficWarnPercent: number;
  trafficCriticalPercent: number;
  notificationEmailEnabled: boolean;
  notificationWebhookUrl: string | null;
  allowUserSelfService: boolean;
  registrationEnabled: boolean;
}

export interface SecuritySettings {
  sessionTimeoutMinutes: number;
  passwordMinLength: number;
  requireMfa: boolean;
  maxLoginAttempts: number;
  ipAllowlist: string[];
  forceHttps: boolean;
}

export interface ServerSettings {
  defaultPort: number;
  defaultProtocol: string;
  heartbeatTimeoutSeconds: number;
  allowSelfSignedAgent: boolean;
}

export interface TrafficSettings {
  countingMode: 'server' | 'config' | 'user';
  resetPeriod: 'never' | 'monthly' | 'custom';
  resetDayOfMonth: number;
  autoSuspendOnExceed: boolean;
}

export interface BrandingSettings {
  primaryColor: string;
  accentColor: string;
  footerText: string;
  supportUrl: string | null;
}

export interface AllSettings {
  general: GeneralSettings;
  security: SecuritySettings;
  server: ServerSettings;
  traffic: TrafficSettings;
  branding: BrandingSettings;
}

export function settingsDefaults(): AllSettings {
  const env = getEnv();
  return {
    general: {
      appName: env.APP_NAME,
      logoUrl: null,
      defaultTrafficLimitGb: env.DEFAULT_TRAFFIC_LIMIT_GB,
      defaultExpirationDays: env.DEFAULT_EXPIRATION_DAYS,
      monitoringIntervalSeconds: env.MONITOR_INTERVAL_SECONDS,
      trafficWarnPercent: env.DEFAULT_TRAFFIC_WARN_PERCENT,
      trafficCriticalPercent: Math.min(99, env.DEFAULT_TRAFFIC_WARN_PERCENT + 15),
      notificationEmailEnabled: Boolean(env.SMTP_URL),
      notificationWebhookUrl: null,
      allowUserSelfService: true,
      registrationEnabled: false,
    },
    security: {
      sessionTimeoutMinutes: env.DEFAULT_SESSION_TIMEOUT_MINUTES,
      passwordMinLength: 8,
      requireMfa: false,
      maxLoginAttempts: 8,
      ipAllowlist: [],
      forceHttps: env.NODE_ENV === 'production',
    },
    server: {
      defaultPort: 443,
      defaultProtocol: 'VLESS',
      heartbeatTimeoutSeconds: Math.max(env.MONITOR_INTERVAL_SECONDS * 3, 120),
      allowSelfSignedAgent: false,
    },
    traffic: {
      countingMode: 'config',
      resetPeriod: 'monthly',
      resetDayOfMonth: 1,
      autoSuspendOnExceed: true,
    },
    branding: {
      primaryColor: '#4f46e5',
      accentColor: '#0ea5e9',
      footerText: '',
      supportUrl: null,
    },
  };
}

/** Read the full merged settings tree. */
export async function getSettings(): Promise<AllSettings> {
  const defaults = settingsDefaults();
  const rows = await prisma.systemSetting.findMany();

  const merged: AllSettings = {
    general: { ...defaults.general },
    security: { ...defaults.security },
    server: { ...defaults.server },
    traffic: { ...defaults.traffic },
    branding: { ...defaults.branding },
  };

  for (const row of rows) {
    const category = row.category as SettingsCategory;
    if (category in merged && row.value && typeof row.value === 'object') {
      Object.assign(merged[category], row.value as Record<string, unknown>);
    }
  }

  return merged;
}

export async function getSettingsCategory<C extends SettingsCategory>(
  category: C,
): Promise<AllSettings[C]> {
  const all = await getSettings();
  return all[category];
}

/** Subset of settings safe to expose on the unauthenticated login page. */
export async function getPublicSettings() {
  const { general, branding } = await getSettings();
  return {
    appName: general.appName,
    logoUrl: general.logoUrl,
    branding,
  };
}

/**
 * Persist a partial settings update. Only the provided categories/keys change;
 * everything else keeps its current effective value.
 */
export async function updateSettings(
  input: Partial<Record<SettingsCategory, Record<string, unknown>>>,
  actor: { id: string; username: string } | null,
  options: { security?: boolean } = {},
): Promise<AllSettings> {
  for (const [category, values] of Object.entries(input)) {
    if (!values || typeof values !== 'object') continue;

    const existing = await prisma.systemSetting.findUnique({ where: { key: category } });
    const nextValue = {
      ...((existing?.value as Record<string, unknown> | null) ?? {}),
      ...values,
    };

    await prisma.systemSetting.upsert({
      where: { key: category },
      create: {
        key: category,
        category,
        value: nextValue as object,
        updatedById: actor?.id ?? null,
      },
      update: { value: nextValue as object, updatedById: actor?.id ?? null },
    });
  }

  await recordAudit({
    actorId: actor?.id ?? null,
    actorName: actor?.username ?? null,
    action: options.security ? AUDIT_ACTIONS.SETTINGS_SECURITY_UPDATE : AUDIT_ACTIONS.SETTINGS_UPDATE,
    targetType: 'settings',
    targetId: Object.keys(input).join(','),
    metadata: { categories: Object.keys(input) },
  });

  return getSettings();
}
