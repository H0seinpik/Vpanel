import { PrismaClient, ProtocolType, UserRole, UserStatus, ServerType } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Database seed.
 *
 * Idempotent: safe to run repeatedly. Creates the role catalog, protocol
 * catalog, default plans, baseline system settings and the bootstrap
 * administrator from environment variables.
 *
 * Demo data (a sample server / user / configuration) is only created when
 * SEED_DEMO=true, so production deployments never start with placeholder rows.
 */

const prisma = new PrismaClient();

const ROLE_DEFINITIONS = [
  {
    key: UserRole.ADMIN,
    name: 'Administrator',
    description: 'Full access including security settings and administrator accounts.',
    permissions: ['*'],
  },
  {
    key: UserRole.OPERATOR,
    name: 'Operator',
    description:
      'Manages users, servers, configurations and traffic. Cannot change security settings or administrator accounts.',
    permissions: [
      'users:read',
      'users:write',
      'users:reset-password',
      'servers:read',
      'servers:write',
      'configs:read',
      'configs:write',
      'configs:delete',
      'tunnels:read',
      'tunnels:write',
      'tunnels:delete',
      'plans:read',
      'plans:write',
      'subscriptions:read',
      'subscriptions:write',
      'traffic:read',
      'monitoring:read',
      'logs:read',
      'settings:read',
    ],
  },
  {
    key: UserRole.USER,
    name: 'User',
    description: 'Access to their own dashboard, configurations, traffic and profile only.',
    permissions: ['self:read', 'self:configs', 'self:traffic', 'self:devices', 'self:profile'],
  },
];

const PROTOCOLS = [
  {
    type: ProtocolType.VLESS,
    name: 'VLESS',
    description: 'Lightweight, stateless protocol. Supports XTLS-Vision and REALITY.',
    defaultParams: { encryption: 'none', network: 'tcp', security: 'none', flow: '' },
  },
  {
    type: ProtocolType.VMESS,
    name: 'VMess',
    description: 'Widely compatible legacy protocol with UUID authentication.',
    defaultParams: { alterId: 0, cipher: 'auto', network: 'tcp', security: 'none' },
  },
  {
    type: ProtocolType.TROJAN,
    name: 'Trojan',
    description: 'TLS-mimicking protocol, indistinguishable from regular HTTPS traffic.',
    defaultParams: { network: 'tcp', security: 'tls' },
  },
  {
    type: ProtocolType.SHADOWSOCKS,
    name: 'Shadowsocks',
    description: 'Simple, fast encrypted proxy with a choice of AEAD ciphers.',
    defaultParams: { method: 'chacha20-ietf-poly1305' },
  },
];

const PLANS = [
  {
    name: 'Basic',
    description: 'Entry-level plan for light usage.',
    priceCents: 500,
    trafficLimitGb: 100,
    durationDays: 30,
    deviceLimit: 2,
  },
  {
    name: 'Pro',
    description: 'Balanced plan for everyday use across several devices.',
    priceCents: 1200,
    trafficLimitGb: 500,
    durationDays: 30,
    deviceLimit: 5,
  },
  {
    name: 'Unlimited',
    description: 'No traffic cap, generous device allowance.',
    priceCents: 2500,
    trafficLimitGb: null,
    durationDays: 30,
    deviceLimit: 10,
    isDefault: true,
  },
];

async function main() {
  console.log('→ Seeding roles…');
  for (const role of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: role.key },
      create: { ...role, isSystem: true },
      update: { name: role.name, description: role.description, permissions: role.permissions },
    });
  }

  console.log('→ Seeding protocol catalog…');
  for (const protocol of PROTOCOLS) {
    await prisma.protocol.upsert({
      where: { type: protocol.type },
      create: protocol,
      update: { name: protocol.name, description: protocol.description },
    });
  }

  console.log('→ Seeding plans…');
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      create: {
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: 'USD',
        trafficLimitBytes:
          plan.trafficLimitGb === null ? null : BigInt(Math.round(plan.trafficLimitGb * 1024 ** 3)),
        durationDays: plan.durationDays,
        deviceLimit: plan.deviceLimit,
        isDefault: plan.isDefault ?? false,
        status: 'ACTIVE',
      },
      update: {},
    });
  }

  console.log('→ Seeding system settings…');
  const settings = [
    { key: 'general', category: 'general', value: { appName: 'VPanel' } },
    { key: 'security', category: 'security', value: { requireMfa: false } },
  ];
  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      create: { key: setting.key, category: setting.category, value: setting.value },
      update: {},
    });
  }

  // --- Bootstrap administrator ---------------------------------------------
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminPassword) {
    console.warn(
      '⚠  SEED_ADMIN_PASSWORD is not set — skipping administrator creation.\n' +
        '   Set it in .env and re-run `npm run db:seed` to create the first admin.',
    );
  } else {
    console.log('→ Seeding bootstrap administrator…');
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const adminRole = await prisma.role.findUnique({ where: { key: UserRole.ADMIN } });

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: adminEmail }, { username: adminUsername }] },
    });

    if (existing) {
      console.log(`   Administrator "${existing.username}" already exists — left unchanged.`);
    } else {
      await prisma.user.create({
        data: {
          username: adminUsername,
          displayName: 'Administrator',
          email: adminEmail,
          passwordHash,
          role: UserRole.ADMIN,
          roleId: adminRole?.id ?? null,
          status: UserStatus.ACTIVE,
          trafficLimitBytes: null,
          expirationDate: null,
          notes: 'Bootstrap administrator created by the seed script.',
        },
      });
      console.log(`   Created administrator "${adminUsername}" <${adminEmail}>.`);
      console.log('   ⚠  Change this password immediately after your first login.');
    }
  }

  // --- Optional demo data ---------------------------------------------------
  if (process.env.SEED_DEMO === 'true') {
    console.log('→ Seeding demo data (SEED_DEMO=true)…');

    const demoServer = await prisma.server.upsert({
      where: { hostname_port: { hostname: 'demo-node-01.example.com', port: 443 } },
      create: {
        name: 'Demo Node 01',
        hostname: 'demo-node-01.example.com',
        ipAddress: '203.0.113.10',
        port: 443,
        protocol: ProtocolType.VLESS,
        type: ServerType.XRAY,
        location: 'Frankfurt, DE',
        status: 'ONLINE',
        description: 'Placeholder server used for local development and demos.',
        monitoringEnabled: true,
      },
      update: {},
    });

    const demoRole = await prisma.role.findUnique({ where: { key: UserRole.USER } });
    const demoPassword = await bcrypt.hash('DemoUser_123!', 12);
    const demoUser = await prisma.user.upsert({
      where: { username: 'demo' },
      create: {
        username: 'demo',
        displayName: 'Demo User',
        email: 'demo@example.com',
        passwordHash: demoPassword,
        role: UserRole.USER,
        roleId: demoRole?.id ?? null,
        status: UserStatus.ACTIVE,
        trafficLimitBytes: BigInt(100 * 1024 ** 3),
        expirationDate: new Date(Date.now() + 30 * 86_400_000),
      },
      update: {},
    });

    const protocolRow = await prisma.protocol.findUnique({ where: { type: ProtocolType.VLESS } });
    const existingConfig = await prisma.configuration.findFirst({
      where: { name: 'Demo Germany Node 01' },
    });

    if (!existingConfig && protocolRow) {
      const { generateCredential } = await import('../src/services/config-generator');
      const credential = generateCredential('VLESS');

      const config = await prisma.configuration.create({
        data: {
          name: 'Demo Germany Node 01',
          serverId: demoServer.id,
          protocolId: protocolRow.id,
          type: ProtocolType.VLESS,
          ownerId: demoUser.id,
          params: {
            address: demoServer.hostname,
            port: demoServer.port,
            network: 'ws',
            security: 'tls',
            sni: demoServer.hostname,
            host: demoServer.hostname,
            path: '/ray',
            encryption: 'none',
          },
        },
      });

      await prisma.configAssignment.create({
        data: {
          configId: config.id,
          userId: demoUser.id,
          credential: credential as object,
        },
      });
      console.log('   Created demo server, user (demo / DemoUser_123!) and configuration.');
    }
  }

  console.log('✓ Seed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
