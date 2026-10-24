/**
 * Guards that stop a transient database read from taking the node down.
 *
 * THE INCIDENT THIS PREVENTS
 * --------------------------
 * On 2026-09-28 `config.json` was observed fully wiped for ~12 minutes
 * (`No active configurations - config cleared`, six times in a row). Every
 * client got `context deadline exceeded` because Xray had no listening ports
 * at all. The wipe was not caused by the operator deleting anything: a second,
 * stale worker process rendered from a momentarily-empty view of the database
 * and wrote the empty config over the good one.
 *
 * `syncXray()` treats `rendered.config === null` as "the operator removed every
 * configuration" and deliberately wipes the file so a manual Xray start serves
 * nothing. That behaviour is correct for a real deletion and catastrophic for a
 * transient read. These helpers tell the two apart.
 *
 * Pure functions only — no I/O, no Prisma — so the decision is unit-testable.
 */

/**
 * How many consecutive empty reads before we accept that the operator really
 * did remove everything.
 *
 * One empty read is indistinguishable from a short-lived transaction, a
 * connection-pool blip or a second worker mid-restart. Requiring two in a row
 * costs one extra reconcile tick (15 s) on a genuine deletion and removes the
 * entire class of accident that caused the outage.
 */
export const EMPTY_RENDER_CONFIRMATIONS = 2;

export interface EmptyRenderInput {
  /** How many consecutive reconciles have rendered an empty config. */
  consecutiveEmptyRenders: number;
  /** Is anything currently listening / is Xray running? */
  xrayRunning: boolean;
}

export type EmptyRenderVerdict =
  | { action: 'apply'; reason: string }
  | { action: 'hold'; reason: string };

/**
 * Decide whether an empty render may be applied to the node.
 *
 * `hold` means: keep serving the previous configuration and re-check next tick.
 * `apply` means: the empty state has been confirmed, wipe the config.
 *
 * The confirmation counter is incremented by the caller before this is called,
 * so on the first empty read it is 1.
 */
export function decideEmptyRender(input: EmptyRenderInput): EmptyRenderVerdict {
  const { consecutiveEmptyRenders, xrayRunning } = input;

  if (consecutiveEmptyRenders < EMPTY_RENDER_CONFIRMATIONS) {
    return {
      action: 'hold',
      reason:
        `empty render ${consecutiveEmptyRenders}/${EMPTY_RENDER_CONFIRMATIONS} — ` +
        `treating as a transient read and keeping the previous configuration` +
        (xrayRunning ? ' (node still serving)' : ''),
    };
  }

  return {
    action: 'apply',
    reason: `empty render confirmed ${consecutiveEmptyRenders}x — clearing the node`,
  };
}

/**
 * Is a rendered config safe to hand to Xray?
 *
 * Xray refuses to start on a malformed config, and a refusal takes down every
 * port on the machine, not just the offending one. A render that produced
 * inbounds but no listening port, or no outbound at all, is never worth
 * applying — better to keep the previous working file and surface the problem.
 */
export interface RenderedConfigShape {
  inbounds?: Array<{ port?: number; protocol?: string }>;
  outbounds?: Array<{ protocol?: string }>;
}

export function assertRenderIsApplicable(config: unknown): { ok: true } | { ok: false; reason: string } {
  if (config === null || typeof config !== 'object') {
    return { ok: false, reason: 'render produced no config object' };
  }

  const c = config as RenderedConfigShape;
  const inbounds = Array.isArray(c.inbounds) ? c.inbounds : [];
  const outbounds = Array.isArray(c.outbounds) ? c.outbounds : [];

  // The stats API inbound is added by the renderer and is always present when
  // any real inbound exists, so counting inbounds is enough to spot a wipe.
  if (inbounds.length === 0) {
    return { ok: false, reason: 'render produced no inbounds' };
  }

  const listening = inbounds.filter((i) => typeof i.port === 'number' && i.port > 0);
  if (listening.length === 0) {
    return { ok: false, reason: 'render produced no inbound with a real port' };
  }

  if (outbounds.length === 0) {
    return { ok: false, reason: 'render produced no outbound' };
  }

  return { ok: true };
}
