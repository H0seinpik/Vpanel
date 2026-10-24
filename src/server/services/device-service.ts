import { DevicePlatform, DeviceStatus, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit';
import { createNotification } from './notification-service';
import type { ActorContext } from './user-service';

/**
 * Device management.
 *
 * Devices are client-side registrations (name + platform + an opaque client
 * key). They are NOT hardware fingerprints — nothing is read from the client
 * beyond what the user themselves provides. Administrators can revoke a device;
 * users can register and remove their own within their plan's device limit.
 */

export async function listDevices(userId: string) {
  return prisma.device.findMany({
    where: { userId },
    orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
  });
}

export interface RegisterDeviceInput {
  name: string;
  platform?: DevicePlatform;
  deviceKey?: string;
  userAgent?: string;
  ip?: string | null;
}

export async function registerDevice(userId: string, input: RegisterDeviceInput) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { plan: true, devices: { where: { status: DeviceStatus.ACTIVE } } },
  });
  if (!user) throw new NotFoundError('User');

  const limit = user.plan?.deviceLimit ?? 0;
  if (limit > 0 && user.devices.length >= limit) {
    throw new ValidationError(
      `Your plan allows ${limit} device(s). Remove a device or upgrade your plan.`,
    );
  }

  if (input.deviceKey) {
    const existing = await prisma.device.findFirst({
      where: { userId, deviceKey: input.deviceKey },
    });
    if (existing) {
      // Re-registering a known device simply refreshes its "last seen" stamp.
      return prisma.device.update({
        where: { id: existing.id },
        data: {
          status: DeviceStatus.ACTIVE,
          name: input.name,
          platform: input.platform ?? existing.platform,
          lastSeenAt: new Date(),
          lastIp: input.ip ?? existing.lastIp,
          userAgent: input.userAgent ?? existing.userAgent,
        },
      });
    }
  }

  return prisma.device.create({
    data: {
      userId,
      name: input.name,
      platform: input.platform ?? DevicePlatform.OTHER,
      deviceKey: input.deviceKey ?? null,
      userAgent: input.userAgent ?? null,
      lastIp: input.ip ?? null,
      lastSeenAt: new Date(),
    },
  });
}

export async function revokeDevice(deviceId: string, actor: ActorContext, userId?: string) {
  const where: Prisma.DeviceWhereInput = userId ? { id: deviceId, userId } : { id: deviceId };
  const device = await prisma.device.findFirst({ where });
  if (!device) throw new NotFoundError('Device');

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { status: DeviceStatus.REVOKED },
  });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.DEVICE_REVOKE,
    targetType: 'device',
    targetId: device.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: { userId: device.userId, name: device.name },
  });

  if (actor.id !== device.userId) {
    await createNotification({
      userId: device.userId,
      type: 'SYSTEM',
      severity: 'WARNING',
      title: 'Device access revoked',
      message: `Access for "${device.name}" has been revoked by an administrator.`,
      dedupeKey: `device:${device.id}:revoked`,
      metadata: { deviceId: device.id },
    });
  }

  return updated;
}

/** Remove a device entirely (user-initiated cleanup). */
export async function deleteDevice(deviceId: string, userId: string, actor: ActorContext) {
  const device = await prisma.device.findFirst({ where: { id: deviceId, userId } });
  if (!device) throw new NotFoundError('Device');

  await prisma.device.delete({ where: { id: device.id } });

  await recordAudit({
    actorId: actor.id,
    actorName: actor.username,
    action: AUDIT_ACTIONS.DEVICE_REVOKE,
    targetType: 'device',
    targetId: deviceId,
    metadata: { deleted: true },
  });

  return { id: deviceId };
}

export async function touchDevice(deviceId: string) {
  await prisma.device
    .update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}
