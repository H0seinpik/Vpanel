import { NextResponse } from 'next/server';
import { ConfigStatus, SubscriptionStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/sub/:token — the client-facing subscription feed.
 *
 * Returns the user's ACTIVE share links, one per line, Base64-encoded — the
 * format v2rayNG, NekoBox, sing-box and Shadowrocket all expect — plus the
 * standard `Subscription-Userinfo` header so the app can display usage:
 *
 *   Subscription-Userinfo: upload=…; download=…; total=…; expire=…
 *
 * Why this route is NOT behind `withAuth`: a subscription URL is fetched by the
 * phone itself, with no cookie jar. The unguessable subscription id is the
 * credential, exactly like every other panel's subscription link.
 *
 * `total=0` and `expire=0` are the conventional "unlimited" / "never expires".
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function text(body: string, status: number) {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
  });
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: params.token },
    include: { user: true, plan: true },
  });

  if (!subscription) return text('Subscription not found', 404);

  if (subscription.status !== SubscriptionStatus.ACTIVE) {
    return text(`Subscription is ${subscription.status.toLowerCase().replace('_', ' ')}`, 403);
  }
  if (subscription.endsAt && subscription.endsAt.getTime() <= Date.now()) {
    return text('Subscription has expired', 403);
  }

  // --- The configs ---------------------------------------------------------
  // Only ACTIVE assignments of ACTIVE configurations, scoped to the
  // subscription's server when it has one. The stored `shareLink` is the exact
  // link the panel hands out (credential + certificate pin already applied).
  const assignments = await prisma.configAssignment.findMany({
    where: {
      userId: subscription.userId,
      status: ConfigStatus.ACTIVE,
      config: {
        status: ConfigStatus.ACTIVE,
        ...(subscription.serverId ? { serverId: subscription.serverId } : {}),
      },
      shareLink: { not: null },
    },
    select: { shareLink: true },
    orderBy: { createdAt: 'asc' },
  });

  const links = assignments
    .map((assignment) => assignment.shareLink)
    .filter((link): link is string => Boolean(link));

  if (links.length === 0) return text('No active configurations', 404);

  // Base64 of the newline-joined links — unchanged from what the panel delivers.
  const body = Buffer.from(links.join('\n'), 'utf8').toString('base64');

  // --- Usage for the header ------------------------------------------------
  // `Subscription.trafficUsedBytes` is authoritative (it survives a manual
  // reset); the ledger is only used to split that total into up/down.
  const used = subscription.trafficUsedBytes;

  const ledger = await prisma.trafficUsage.aggregate({
    where: {
      userId: subscription.userId,
      ...(subscription.serverId ? { serverId: subscription.serverId } : {}),
      timestamp: { gte: subscription.startsAt },
    },
    _sum: { uploadBytes: true, downloadBytes: true },
  });

  let uploaded = ledger._sum.uploadBytes ?? 0n;
  let downloaded = ledger._sum.downloadBytes ?? 0n;

  // After a reset the ledger still holds the old rows. Scale the split so the
  // pair always adds up to the authoritative counter instead of over-reporting.
  const ledgerTotal = uploaded + downloaded;
  if (ledgerTotal > 0n && ledgerTotal !== used) {
    uploaded = (used * uploaded) / ledgerTotal;
    downloaded = used - uploaded;
  } else if (ledgerTotal === 0n) {
    downloaded = used;
  }

  const total = subscription.trafficLimitBytes ?? subscription.plan?.trafficLimitBytes ?? 0n;
  // Unix seconds; 0 means "never expires".
  const expire = subscription.endsAt ? Math.floor(subscription.endsAt.getTime() / 1000) : 0;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Subscription-Userinfo': `upload=${uploaded}; download=${downloaded}; total=${total}; expire=${expire}`,
      'Profile-Title': subscription.user.username,
      'Content-Disposition': `attachment; filename="${subscription.user.username}"`,
      ...NO_STORE,
    },
  });
}
