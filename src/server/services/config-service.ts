import { ConfigStatus, Prisma, ProtocolType, UserRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { gbToBytes, mbToBytes } from '@/lib/format';
import {
  applyCredential,
  generateConfig,
  generateCredential,
  safeValidateParams,
  validateParams,
} from '@/services/config-generator';
import { isStaff } from '@/lib/auth/rbac';
import { staticPortConflict } from '@/services/port-conflicts';
import { shareIneligible } from '@/services/port-sharing';
import { createNotification } from './notification-service';
import {
  generateRealityKeypair,
  getCertificatePaths,
  triggerXraySync,
  withTlsPin,
} from './xray-service';
import { randomShortId, REALITY_DEFAULTS } from '@/services/reality';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ActorContext } from './user-service';

/**
 * Configuration management.
 *
 * Security model — the important part:
 *
 *   `Configuration.params` holds ONLY non-secret transport parameters.
 *   Credentials live exclusively in `ConfigAssignment.credential`, one row per
 *   user. A configuration can therefore belong to one user (single-user model)
 *   or many users (multi-user model) while guaranteeing that:
 *
 *     - every user gets an INDEPENDENT credential (fresh UUID / passphrase),
 *     - no user can ever read another user's credential,
 *     - the share link a user receives is generated from THEIR credential only.
 */

const CREDENTIAL_FIELDS = ['uuid', 'password'] as const;

function extractCredential(params: Record<string, unknown>): Record<string, unknown> {
  const credential: Record<string, unknown> = {};
  for (const field of CREDENTIAL_FIELDS) {
    if (typeof params[field] === 'string' && params[field]) credential[field] = params[field];
  }
  return credential;
}

function stripCredential(params: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...params };
  for (const field of CREDENTIAL_FIELDS) delete clone[field];
  return clone;
}

export interface ListConfigsQuery {
  search?: string;
  serverId?: string;
  protocol?: ProtocolType;
  status?: ConfigStatus;
  userId?: string;
  sort?: 'createdAt' | 'name' | 'type';
  order?: 'asc' | 'desc';
}

export async function listConfigs(
  query: ListConfigsQuery,
  pagination: { skip: number; take: number },
  actor: ActorContext,
) {
  const where: Prisma.ConfigurationWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { remarks: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.serverId) where.serverId = query.serverId;
  if (query.protocol) where.type = query.protocol;
  if (query.status) where.status = query.status;

  // A USER only ever sees configurations assigned to them.
  if (!isStaff(actor.role)) {
    where.assignments = { some: { userId: actor.id } };
  } else if (query.userId) {
    where.assignments = { some: { userId: query.userId } };
  }

    const [rows, total] = await Promise.all([
      prisma.configuration.findMany({
        where,
        orderBy: { [query.sort ?? 'createdAt']: query.order ?? 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: {
          server: { select: { id: true, name: true, hostname: true, location: true, status: true } },
          owner: { select: { id: true, username: true, displayName: true, email: true } },
          protocol: { select: { id: true, type: true, name: true } },
          _count: { select: { assignments: true } },
          // Usage is recorded per assignment, so the list needs the sum of them.
          assignments: { select: { trafficUsedBytes: true } },
        },
      }),
      prisma.configuration.count({ where }),
    ]);

    const items = rows.map((row) => ({
      ...row,
      trafficUsedBytes: row.assignments.reduce(
        (sum, assignment) => sum + assignment.trafficUsedBytes,
        0n,
      ),
    }));

    return { items, total };
  }

/** Load a configuration, enforcing that the actor may see it. */
export async function getConfigForActor(id: string, actor: ActorContext) {
  const config = await prisma.configuration.findUnique({
    where: { id },
    include: {
      server: { select: { id: true, name: true, hostname: true, location: true, status: true } },
      owner: { select: { id: true, username: true, displayName: true, email: true } },
      protocol: { select: { id: true, type: true, name: true } },
      assignments: {
        include: { user: { select: { id: true, username: true, displayName: true, email: true } } },
      },
    },
  });

  if (!config) throw new NotFoundError('Configuration');

  if (!isStaff(actor.role)) {
    const mine = config.assignments.some((a) => a.userId === actor.id);
    if (!mine) {
      // Deliberately 403 (not 404): the resource exists but is not theirs.
      throw new ForbiddenError('You do not have access to this configuration.');
    }
  }

  return config;
}

/** Ensure a protocol catalog row exists for the given type. */
async function ensureProtocolRow(type: ProtocolType) {
  return prisma.protocol.upsert({
    where: { type },
    create: {
      type,
      name: type,
      description: `${type} protocol definition`,
      defaultParams: {},
    },
    update: {},
  });
}

export interface CreateConfigInput {
  name: string;
  serverId: string;
  protocol: ProtocolType;
  ownerId?: string | null;
  userIds?: string[];
  params: Record<string, unknown>;
  remarks?: string;
  /** The configuration's own allowance, in either unit (MB wins if both set). */
  trafficLimitGb?: number | null;
  trafficLimitMb?: number | null;
  expirationDays?: number | null;
}

/**
 * Resolve a configuration's own traffic ceiling from whichever unit was sent.
 * MB is preferred when both are present because it is the more specific entry.
 */
function resolveConfigLimit(input: {
  trafficLimitGb?: number | null;
  trafficLimitMb?: number | null;
}): bigint | null {
  if (input.trafficLimitMb !== undefined && input.trafficLimitMb !== null) {
    return mbToBytes(input.trafficLimitMb);
  }
  if (input.trafficLimitGb !== undefined && input.trafficLimitGb !== null) {
    return gbToBytes(input.trafficLimitGb);
  }
  return null;
}

/**
 * Reject configurations that cannot possibly work, with a message that says why.
 *
 * Two failures are silent and extremely confusing from the outside:
 *
 *   1. Two ACTIVE configurations on the same port. Only one inbound can bind a
 *      port, so the others simply never answer — the client reports "no internet"
 *      and nothing in the panel explains it.
 *   2. A TLS transport with no certificate. The server has nothing to present,
 *      so every handshake fails.
 *
 * Catching them here turns a mystery into an error message.
 */
async function assertConfigIsServable(input: {
  serverId: string;
  type: ProtocolType;
  params: Record<string, unknown>;
  /** Ignore this configuration — used when updating an existing one. */
  excludeId?: string;
  /** Only ACTIVE configurations contend for a port. Defaults to true. */
  active?: boolean;
}): Promise<void> {
  if (input.active === false) return;

  const port = Number(input.params.port);
  if (!Number.isFinite(port) || port <= 0) return; // the generator reports this

  // Ports Windows itself owns can never be bound. Catching that here turns a
  // mystifying "all my other configurations stopped working" into a one-line
  // explanation at the moment the configuration is created. See
  // `src/services/port-conflicts.ts` for why 445 in particular is a trap: SMB
  // keeps it listening, so it looks like a working port that simply never
  // carries any traffic.
  const reserved = staticPortConflict(port);
  if (reserved) {
    throw new ValidationError(
      `Port ${port} ${reserved.reason}. ${reserved.fix}. ` +
        'Xray cannot start at all while one of its inbounds points at an unavailable port, ' +
        'so this would also stop every other configuration on this machine from working.',
    );
  }

  // Tunnels share the same local node and cannot share a socket with a
  // configuration. Checked globally because the supervisor renders every row
  // into one Xray config, regardless of which "server" a row names.
  const tunnel = await prisma.tunnel.findFirst({
    where: { listenPort: port, enabled: true },
    select: { name: true },
  });
  if (tunnel) {
    throw new ValidationError(
      `Port ${port} is already used by tunnel "${tunnel.name}". ` +
        'A configuration cannot share a port with a tunnel — give the configuration its own port, ' +
        'or disable/delete the tunnel first.',
    );
  }

  // Compare against the port a configuration ACTUALLY ends up using, which may
  // be inherited from the server rather than written into `params`. Checking
  // only `params.port` let two configurations both fall back to the server
  // default and race for the same port.
  const incoming = {
    name: 'this configuration',
    protocol: input.type,
    security: String(input.params.security ?? ''),
    network: String(input.params.network ?? 'tcp'),
    path: input.params.path ? String(input.params.path) : null,
  };

  const contenders = await prisma.configuration.findMany({
    where: {
      serverId: input.serverId,
      status: ConfigStatus.ACTIVE,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    select: { name: true, type: true, params: true, server: { select: { port: true } } },
  });

  const samePort = contenders.filter((row) => {
    const candidate = Number(
      (row.params as Record<string, unknown> | null)?.port ?? row.server.port,
    );
    return candidate === port;
  });

  if (samePort.length > 0) {
    // Several configurations CAN share one port — that is what fallbacks are
    // for. But only when every one of them qualifies: both the new
    // configuration and each existing occupant must be able to be routed by
    // path. A VMess configuration on a shared port would bind the port and then
    // carry no traffic at all, which is a silent failure, so it is refused
    // instead.
    const shareable = [incoming, ...samePort.map((row) => ({
      name: row.name,
      protocol: row.type,
      security: String((row.params as Record<string, unknown> | null)?.security ?? ''),
      network: String((row.params as Record<string, unknown> | null)?.network ?? 'tcp'),
      path: (row.params as Record<string, unknown> | null)?.path
        ? String((row.params as Record<string, unknown> | null)?.path)
        : null,
    }))];

    const blockers = shareable
      .map((candidate) => shareIneligible({ id: candidate.name, ...candidate }))
      .filter((rejection): rejection is NonNullable<typeof rejection> => rejection !== null);

    if (blockers.length > 0) {
      const detail = blockers.map((b) => `  · "${b.name}" — ${b.reason}. ${b.fix}`).join('\n');

      // Name the exact configuration that is in the way, so the operator knows
      // which one to change rather than being told to change "both". In the
      // common case the blocker is an existing configuration whose transport is
      // `tcp`; pointing at it by name turns a confusing refusal into a task.
      const named = blockers.filter((b) => b.name !== 'this configuration');

      // A REALITY occupant changes the advice completely. REALITY can never share
      // a port, and "recreate it with ws" would throw away the one property that
      // makes it connect from every app. What the operator actually wants — one
      // more customer on this port — is reached by adding a USER to the existing
      // configuration, where each user gets their own UUID and their own link.
      const realityOccupant = samePort.find(
        (row) => String((row.params as Record<string, unknown> | null)?.security ?? '') === 'reality',
      );

      const advice = realityOccupant
        ? `To give another customer port ${port}, open "${realityOccupant.name}" and use ` +
          `"Add user". Every user gets their own link (own UUID, own traffic counter) from ` +
          `this same port — do NOT create a second configuration here.`
        : named.length > 0
          ? `Recreate "${named[0]!.name}" with the "ws" transport, then create this one on port ` +
            `${port}. Or give this configuration its own port.`
          : `Give this configuration its own port, or use VLESS with security "tls" and the ` +
            `"ws" transport so it can share port ${port}.`;

      throw new ValidationError(
        `Port ${port} is already used by "${samePort[0]!.name}", and the configurations cannot ` +
          `share it:\n${detail}\n\n${advice}`,
      );
    }
  }

  const security = String(input.params.security ?? '');
  const needsTls = input.type === ProtocolType.TROJAN || security === 'tls';
  if (needsTls) {
    const { cert, key } = getCertificatePaths();
    if (!existsSync(cert) || !existsSync(key)) {
      throw new ValidationError(
        `${input.type}${security ? ` with security="${security}"` : ''} needs a TLS certificate, ` +
          `and none was found at ${cert}. Run xray-gencert.bat to generate a self-signed pair, ` +
          'or use VMess or Shadowsocks, which encrypt on their own and need no certificate.',
      );
    }
  }
}

/**
 * Fill in everything a REALITY configuration needs that an operator cannot be
 * expected to produce by hand: the x25519 keypair, a short ID and the decoy
 * destination. TLS configurations lean on the node certificate (attached at
 * render time); REALITY has none, so the keys ARE the credential and they must
 * exist before the configuration is rendered or its link is useless.
 *
 * Idempotent — an existing keypair is never rotated, because rotating it would
 * silently disconnect every client already holding the old public key.
 */
async function ensureRealityKeys(
  params: Record<string, unknown>,
  protocol: string,
): Promise<Record<string, unknown>> {
  const next = { ...params };

  // Always persist an explicit security value. Leaving the key out produced the
  // worst possible state: the stored params had no `security` at all, the link
  // generator applied its own default, and the two disagreed — a link claiming
  // REALITY with no keypair in it, plus a node that skipped the configuration.
  if (!String(next.security ?? '').trim()) {
    next.security = protocol === 'TROJAN' ? 'tls' : 'none';
  }

  if (String(next.security) !== 'reality') return next;

  if (!String(next.privateKey ?? '').trim() || !String(next.publicKey ?? '').trim()) {
    const pair = await generateRealityKeypair();
    if (!pair) {
      throw new ValidationError('Could not generate REALITY keys — the Xray binary was not found.', [
        'security',
      ]);
    }
    next.privateKey = pair.privateKey;
    next.publicKey = pair.publicKey;
  }

  if (!String(next.shortId ?? '').trim()) next.shortId = randomShortId();
  if (!String(next.sni ?? '').trim()) next.sni = REALITY_DEFAULTS.serverName;
  if (!String(next.realityDest ?? '').trim()) next.realityDest = REALITY_DEFAULTS.dest;

  return next;
}

/**
 * Give a configuration that joins a SHARED port its own request path.
 *
 * The shared listener routes by path, so the path in the client link and the path
 * the node expects must be the SAME string. A blank path used to produce the exact
 * opposite: the generator normalised it to "/" for the link while the node renderer
 * derived `/vp-<configId>` for the fallback — the client reached the shared port,
 * matched no fallback, fell through to the default destination, and carried no
 * data, with no error anywhere. Persisting the path at creation time makes both
 * sides agree, and `planPortSharing` prefers a stored path over a derived one.
 */
async function ensureSharedPath(
  params: Record<string, unknown>,
  serverId: string,
  protocol: string,
  selfId?: string,
): Promise<Record<string, unknown>> {
  const next = { ...params };
  if (String(next.path ?? '').trim()) return next; // the operator chose one

  const port = Number(next.port);
  if (!port) return next;

  // Only a configuration that could share the port needs a path at all.
  const rejection = shareIneligible({
    id: selfId ?? 'pending',
    name: 'this configuration',
    protocol,
    security: String(next.security ?? ''),
    network: String(next.network ?? 'tcp'),
    path: null,
  });
  if (rejection) return next;

  // Is another ACTIVE configuration already listening on this port?
  const others = await prisma.configuration.findMany({
    where: { serverId, status: ConfigStatus.ACTIVE, ...(selfId ? { id: { not: selfId } } : {}) },
    include: { server: { select: { port: true } } },
  });
  const onSamePort = others.filter((candidate) => {
    const other = (candidate.params ?? {}) as Record<string, unknown>;
    const otherPort = Number(other.port ?? candidate.server.port);
    return otherPort === port;
  });
  if (onSamePort.length === 0) return next; // alone on this port

  // Derive a path none of them uses. Any unique `/vp-<slug>` works, because the
  // renderer prefers a stored path over its own derivation.
  const taken = new Set(
    onSamePort
      .map((candidate) => String(((candidate.params ?? {}) as Record<string, unknown>).path ?? '').trim())
      .filter(Boolean),
  );
  let slug: string;
  do {
    slug = 'vp-' + randomBytes(4).toString('hex');
  } while (taken.has('/' + slug));

  next.path = '/' + slug;
  return next;
}

export async function createConfig(input: CreateConfigInput, actor: ActorContext) {
  // --- Validate the server --------------------------------------------------
  const server = await prisma.server.findUnique({ where: { id: input.serverId } });
  if (!server) throw new NotFoundError('Server');

  // --- Normalise parameters -------------------------------------------------
  // The server's own address/port act as defaults so the wizard can be short.
  const rawParams: Record<string, unknown> = {
    address: server.hostname,
    port: server.port,
    ...input.params,
  };

  // REALITY key material must exist before anything downstream renders or
  // validates the configuration.
  let normalizedParams = await ensureRealityKeys(rawParams, input.protocol);

  // A configuration joining a shared port needs its path decided HERE, so the
  // link and the node agree on the same string.
  normalizedParams = await ensureSharedPath(normalizedParams, server.id, input.protocol);

  const templateCredential = extractCredential(normalizedParams);
  const publicParams = stripCredential(normalizedParams);

  // Validate everything except the credential, then validate the credential
  // shape by generating once with a probe credential.
  const probeCredential =
    Object.keys(templateCredential).length > 0
      ? templateCredential
      : generateCredential(input.protocol);

  const probeParams = applyCredential(input.protocol, publicParams, probeCredential);
  const validation = safeValidateParams(input.protocol, probeParams);
  if (!validation.ok) {
    throw new ValidationError('Configuration parameters are invalid', validation.errors);
  }

  // Refuse configurations that could never serve, with a reason the operator
  // can act on. See `assertConfigIsServable`.
  await assertConfigIsServable({
    serverId: input.serverId,
    type: input.protocol,
    params: normalizedParams,
  });

  // --- Determine the assignment set ----------------------------------------
  const assigneeIds = new Set<string>();
  if (input.ownerId) assigneeIds.add(input.ownerId);
  for (const userId of input.userIds ?? []) assigneeIds.add(userId);

  // Staff accounts are not customers: they must never be given a traffic
  // ceiling or an expiry date just because a configuration was assigned to them.
  let staffIds = new Set<string>();

  if (assigneeIds.size > 0) {
    const found = await prisma.user.findMany({
      where: { id: { in: [...assigneeIds] } },
      select: { id: true, role: true },
    });
    if (found.length !== assigneeIds.size) {
      throw new ValidationError('One or more selected users do not exist.');
    }
    staffIds = new Set(
      found
        .filter((user) => user.role === UserRole.ADMIN || user.role === UserRole.OPERATOR)
        .map((user) => user.id),
    );
  }

  const protocolRow = await ensureProtocolRow(input.protocol);

  // --- Persist --------------------------------------------------------------
  const result = await prisma.$transaction(async (tx) => {
    const config = await tx.configuration.create({
      data: {
        name: input.name,
        serverId: server.id,
        protocolId: protocolRow.id,
        type: input.protocol,
        ownerId: input.ownerId ?? null,
        // NOTE: credential fields are intentionally absent here.
        params: publicParams as Prisma.InputJsonValue,
        remarks: input.remarks ?? null,
        status: ConfigStatus.ACTIVE,
        createdById: actor.id,
        // The configuration's own ceiling. This is the figure that stops it.
        trafficLimitBytes: resolveConfigLimit(input),
      },
    });

    const assignments = [];

    for (const userId of assigneeIds) {
      // The owner keeps the credential the administrator typed (if any);
      // every other user always receives a brand-new independent credential.
      const isOwner = userId === input.ownerId;
      const credential =
        isOwner && Object.keys(templateCredential).length > 0
          ? templateCredential
          : generateCredential(input.protocol);

      const rendered = generateConfig(
        input.protocol,
        withTlsPin(applyCredential(input.protocol, publicParams, credential)),
        { name: `${input.name} · ${userId.slice(-6)}` },
      );

      const assignment = await tx.configAssignment.create({
        data: {
          configId: config.id,
          userId,
          credential: credential as Prisma.InputJsonValue,
          shareLink: rendered.shareLink,
          status: ConfigStatus.ACTIVE,
        },
      });
      assignments.push(assignment);

      // Expiry still applies to the assignee — "this access is valid for 30
      // days" is a property of their account. Staff are exempt (see
      // `evaluateUserStatus`) so an administrator is never expired out of the
      // panel they run.
      //
      // The traffic limit deliberately does NOT apply here. It belongs to the
      // configuration and is what stops it; copying it onto users used to hand
      // accounts a quota they never asked for.
      if (!staffIds.has(userId) && input.expirationDays) {
        await tx.user.update({
          where: { id: userId },
          data: { expirationDate: new Date(Date.now() + input.expirationDays * 86_400_000) },
        });
      }
    }

    // Cache the owner's link on the config row for quick admin display.
    //
    // `rawConfig` is deliberately NOT populated. A rendered client config always
    // embeds a credential, and credentials must never live on the Configuration
    // row - they belong to ConfigAssignment, one per user. Per-user artefacts are
    // rendered on demand by `getConfigArtifact()`.
    //
    // (This previously rendered with an empty credential whenever the config had
    // an owner, which made `generateConfig` fail schema validation and broke
    // config creation for every owned configuration.)
    const ownerAssignment = assignments.find((a) => a.userId === input.ownerId);
    const updated = await tx.configuration.update({
      where: { id: config.id },
      data: {
        shareLink: ownerAssignment?.shareLink ?? null,
      },
    });

    return { config: updated, assignments };
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.CONFIG_CREATE,
    targetType: 'configuration',
    targetId: result.config.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: {
      name: result.config.name,
      protocol: result.config.type,
      serverId: server.id,
      assignedUsers: result.assignments.length,
    },
  });

  for (const assignment of result.assignments) {
    await createNotification({
      userId: assignment.userId,
      type: 'SYSTEM',
      severity: 'INFO',
      title: 'New configuration assigned',
      message: `A configuration "${input.name}" has been assigned to your account.`,
      dedupeKey: `assign:${assignment.id}`,
      metadata: { configId: result.config.id },
    });
  }

  // Push the change to the node straight away rather than waiting for the next
  // reconcile tick - a configuration the user just created should work now.
  triggerXraySync();

  return result;
}

export interface UpdateConfigInput {
  name?: string;
  params?: Record<string, unknown>;
  status?: ConfigStatus;
  remarks?: string | null;
  regenerateLinks?: boolean;
  /** Change the configuration's own allowance (either unit; MB wins). */
  trafficLimitGb?: number | null;
  trafficLimitMb?: number | null;
  /** Clear the running total — e.g. after topping the allowance up. */
  resetTraffic?: boolean;
}

export async function updateConfig(id: string, input: UpdateConfigInput, actor: ActorContext) {
  const current = await prisma.configuration.findUnique({
    where: { id },
    include: { assignments: true, server: true },
  });
  if (!current) throw new NotFoundError('Configuration');

  const data: Prisma.ConfigurationUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.status !== undefined) data.status = input.status;
  if (input.remarks !== undefined) data.remarks = input.remarks;

  // Change the configuration's own allowance, and/or clear its running total.
  if (input.trafficLimitGb !== undefined || input.trafficLimitMb !== undefined) {
    data.trafficLimitBytes = resolveConfigLimit(input);
  }
  if (input.resetTraffic) {
    data.trafficUsedBytes = 0n;
  }

  let publicParams = current.params as Record<string, unknown>;

  if (input.params) {
    const merged = { ...publicParams, ...stripCredential(input.params) };

    // A transport switch onto REALITY needs its key material generated here, not
    // at render time — the render would otherwise skip the configuration.
    const withKeys = await ensureRealityKeys(merged, current.type);

    // Moving a configuration onto a port that is already shared needs its own
    // request path, decided here so the link and the node agree.
    const withPath = await ensureSharedPath(withKeys, current.serverId, current.type, id);

    // Validate against a probe credential so transport changes are checked.
    const probe = generateCredential(current.type);
    const validation = safeValidateParams(current.type, applyCredential(current.type, withPath, probe));
    if (!validation.ok) {
      throw new ValidationError('Configuration parameters are invalid', validation.errors);
    }
    publicParams = withPath;
    data.params = withPath as Prisma.InputJsonValue;
  }

  // Check the RESULTING state: activating a configuration, or moving it onto a
  // port that is already taken, must be caught here rather than discovered by a
  // client that cannot connect.
  await assertConfigIsServable({
    serverId: current.serverId,
    type: current.type,
    params: publicParams,
    excludeId: id,
    active: (input.status ?? current.status) === ConfigStatus.ACTIVE,
  });

  const updated = await prisma.configuration.update({ where: { id }, data });

  // Re-render every assignment's link when parameters or links change.
  if (input.params || input.regenerateLinks) {
    for (const assignment of current.assignments) {
      const credential = (assignment.credential as Record<string, unknown>) ?? {};
      const rendered = generateConfig(
        current.type,
        withTlsPin(applyCredential(current.type, publicParams, credential)),
        { name: updated.name },
      );
      await prisma.configAssignment.update({
        where: { id: assignment.id },
        data: { shareLink: rendered.shareLink },
      });
    }

    const ownerAssignment = current.assignments.find((a) => a.userId === current.ownerId);
    await prisma.configuration.update({
      where: { id },
      data: { shareLink: ownerAssignment?.shareLink ?? null },
    });
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.CONFIG_UPDATE,
    targetType: 'configuration',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { fields: Object.keys(input) },
  });

  triggerXraySync();

  return updated;
}

export async function deleteConfig(id: string, actor: ActorContext) {
  const config = await prisma.configuration.findUnique({ where: { id } });
  if (!config) throw new NotFoundError('Configuration');

  await prisma.configuration.delete({ where: { id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.CONFIG_DELETE,
    targetType: 'configuration',
    targetId: id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { name: config.name, protocol: config.type },
  });

  // Revoke on the node immediately. Without this a deleted configuration keeps
  // working, because the node still holds the previous config file.
  triggerXraySync();

  return { id };
}

/** Assign additional users, each receiving an independent credential. */
export async function assignUsers(
  configId: string,
  userIds: string[],
  actor: ActorContext,
  options: { trafficLimitGb?: number | null; expirationDays?: number | null } = {},
) {
  const config = await prisma.configuration.findUnique({
    where: { id: configId },
    include: { assignments: { select: { userId: true } } },
  });
  if (!config) throw new NotFoundError('Configuration');

  const existing = new Set(config.assignments.map((a) => a.userId));
  const toAdd = userIds.filter((id) => !existing.has(id));
  if (toAdd.length === 0) throw new ConflictError('All selected users are already assigned.');

  const users = await prisma.user.findMany({
    where: { id: { in: toAdd } },
    select: { id: true, role: true },
  });

  // Staff accounts are not customers; see the note in createConfig.
  const staffIds = new Set(
    users
      .filter((user) => user.role === UserRole.ADMIN || user.role === UserRole.OPERATOR)
      .map((user) => user.id),
  );
  if (users.length !== toAdd.length) throw new ValidationError('One or more users do not exist.');

  const publicParams = config.params as Record<string, unknown>;
  const created = [];

  for (const userId of toAdd) {
    const credential = generateCredential(config.type);
    const rendered = generateConfig(
      config.type,
      withTlsPin(applyCredential(config.type, publicParams, credential)),
      { name: config.name },
    );

    const assignment = await prisma.configAssignment.create({
      data: {
        configId,
        userId,
        credential: credential as Prisma.InputJsonValue,
        shareLink: rendered.shareLink,
      },
    });
    created.push(assignment);

      if (!staffIds.has(userId)) {
        if (options.trafficLimitGb !== undefined && options.trafficLimitGb !== null) {
          await prisma.user.update({
            where: { id: userId },
            data: { trafficLimitBytes: gbToBytes(options.trafficLimitGb) },
          });
        }
        if (options.expirationDays) {
          await prisma.user.update({
            where: { id: userId },
            data: { expirationDate: new Date(Date.now() + options.expirationDays * 86_400_000) },
          });
        }
      }

    await createNotification({
      userId,
      type: 'SYSTEM',
      severity: 'INFO',
      title: 'New configuration assigned',
      message: `A configuration "${config.name}" has been assigned to your account.`,
      dedupeKey: `assign:${assignment.id}`,
      metadata: { configId },
    });
  }

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.CONFIG_ASSIGN,
    targetType: 'configuration',
    targetId: configId,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { added: toAdd.length },
  });

  triggerXraySync();

  return created;
}

export async function unassignUser(configId: string, userId: string, actor: ActorContext) {
  const assignment = await prisma.configAssignment.findUnique({
    where: { configId_userId: { configId, userId } },
  });
  if (!assignment) throw new NotFoundError('Assignment');

  await prisma.configAssignment.delete({ where: { id: assignment.id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.CONFIG_UNASSIGN,
    targetType: 'configuration',
    targetId: configId,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { userId },
  });

  triggerXraySync();

  return { id: assignment.id };
}

// -----------------------------------------------------------------------------
// Artefact delivery — the ONLY path that returns a credential
// -----------------------------------------------------------------------------

export interface ConfigArtifact {
  shareLink: string;
  qrPayload: string;
  filename: string;
  fileContent: string;
  outbound: Record<string, unknown>;
  serverInbound: Record<string, unknown>;
  warnings: string[];
  protocol: string;
  configName: string;
  /** The user whose credential this artefact was rendered with. */
  forUserId: string;
}

/**
 * Render a configuration artefact for a specific user.
 *
 * A USER may only ever render their own credential. Staff may render any
 * assignment, but must name the target user explicitly.
 */
export async function getConfigArtifact(
  configId: string,
  actor: ActorContext,
  targetUserId?: string,
): Promise<ConfigArtifact> {
  const config = await prisma.configuration.findUnique({
    where: { id: configId },
    include: { assignments: true },
  });
  if (!config) throw new NotFoundError('Configuration');

  const requestedUserId = isStaff(actor.role) ? targetUserId ?? config.ownerId : actor.id;
  if (!requestedUserId) {
    throw new ValidationError(
      'This configuration has no owner. Specify which assigned user the configuration is for.',
    );
  }

  // The access check: non-staff can only ask for their own credential.
  if (!isStaff(actor.role) && requestedUserId !== actor.id) {
    throw new ForbiddenError('You can only access your own configuration.');
  }

  const assignment = config.assignments.find((a) => a.userId === requestedUserId);
  if (!assignment) throw new NotFoundError('Assignment for that user');

  const credential = (assignment.credential as Record<string, unknown>) ?? {};
  // `withTlsPin` attaches the certificate pin for TLS configurations: a
  // self-signed certificate is in no trust store, so without it every handshake
  // fails. (Xray 26 removed `allowInsecure`, which is what this replaces.)
  const params = withTlsPin(
    applyCredential(config.type, config.params as Record<string, unknown>, credential),
  );
  validateParams(config.type, params);

  const rendered = generateConfig(config.type, params, { name: config.name });

  return {
    shareLink: rendered.shareLink,
    qrPayload: rendered.qrPayload,
    filename: rendered.filename,
    fileContent: rendered.fileContent,
    outbound: rendered.outbound,
    serverInbound: rendered.serverInbound,
    warnings: rendered.warnings,
    protocol: rendered.protocol,
    configName: config.name,
    forUserId: requestedUserId,
  };
}

/** Everything a user needs for their own dashboard: configs + links. */
export async function listConfigsForUser(userId: string) {
  const assignments = await prisma.configAssignment.findMany({
    where: { userId },
    include: {
      config: {
        include: {
          server: { select: { id: true, name: true, hostname: true, location: true, status: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    status: assignment.status,
    shareLink: assignment.shareLink,
    trafficUsedBytes: Number(assignment.trafficUsedBytes),
    config: {
      id: assignment.config.id,
      name: assignment.config.name,
      type: assignment.config.type,
      status: assignment.config.status,
      remarks: assignment.config.remarks,
      server: assignment.config.server,
    },
  }));
}

/** Counters for the configurations list header. */
export async function getConfigCounters() {
  const [total, active, disabled, expired] = await Promise.all([
    prisma.configuration.count(),
    prisma.configuration.count({ where: { status: ConfigStatus.ACTIVE } }),
    prisma.configuration.count({ where: { status: ConfigStatus.DISABLED } }),
    prisma.configuration.count({ where: { status: ConfigStatus.EXPIRED } }),
  ]);
  return { total, active, disabled, expired };
}
