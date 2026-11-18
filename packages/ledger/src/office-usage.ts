// Token usage, the owner's plan and its window, and the owner's name and welcome.
import { and, eq } from 'drizzle-orm';
import { db, sql as pg } from './db.ts';
import { fixedError } from './errors.ts';
import { type Db } from './threads.ts';
import { asks, owner, planLimits, usage, type UsageKind } from './schema.ts';
import { zone } from './time.ts';

// Usage and the plan

/** One run's token counts, per model, as Claude Code's result reports them. */
export type ModelUsage = Record<
  string,
  {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }
>;

/** `staffId` is null for a run as the office itself. */
export async function recordUsage(staffId: string | null, kind: UsageKind, byModel: ModelUsage) {
  const rows = Object.entries(byModel).map(([model, u]) => ({
    staffId,
    kind,
    model,
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadInputTokens ?? 0,
    cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
    costUsd: u.costUSD ?? 0
  }));
  if (rows.length) await db.insert(usage).values(rows);
}

/** The plan's one row in plan_limits: the owner's Claude plan, whose windows each run reports. */
export const PLAN_ROW = 'claude';
/** The plan's 5-hour window: one that resets at a time began this long before it. */
export const WINDOW_MS = 5 * 3_600_000;

/**
 * When the window that resets at `resets` began. A window ask raised after
 * it is this window's ask. The loader (`windowNow` in work/load.ts) tests that
 * in SQL and the office clock (`windowAsksDue`) in code, both against this.
 */
export const windowBegan = (resets: Date): Date => new Date(resets.getTime() - WINDOW_MS);

export type PlanWindows = {
  fiveHour: number;
  fiveHourResetsAt: Date | null;
  sevenDay: number;
  sevenDayResetsAt: Date | null;
};

/** A run reports only the windows it has news of, often one: keep the other as it was. */
export async function setPlanLimits(w: Partial<PlanWindows>): Promise<void> {
  await db
    .insert(planLimits)
    .values({ id: PLAN_ROW, fiveHour: 0, sevenDay: 0, ...w, updatedAt: new Date() })
    .onConflictDoUpdate({ target: planLimits.id, set: { ...w, updatedAt: new Date() } });
}

/** Why the office takes a window ask nobody answered off the desk at its window's reset. */
export const WINDOW_ASK_LAPSED = 'The window reset before an answer.';

/**
 * Each open window ask, and when its window resets, for the office clock to
 * take it off the desk then: the ask is about that window, so it leaves when
 * the window does, whatever work it still holds. This window's ask (raised
 * after `windowBegan`) is due at the reset; one from an older window is due
 * already; with no reset reported, a window lasts `WINDOW_MS` at most.
 */
export async function windowAsksDue(): Promise<{ id: number; at: Date }[]> {
  const [row] = await db.select().from(planLimits).where(eq(planLimits.id, PLAN_ROW));
  const resets = row?.fiveHourResetsAt ?? null;
  const open = await db
    .select({ id: asks.id, createdAt: asks.createdAt })
    .from(asks)
    .where(and(eq(asks.kind, 'window'), eq(asks.status, 'open')));
  return open.map(({ id, createdAt }) => {
    if (!resets) return { id, at: new Date(createdAt.getTime() + WINDOW_MS) };
    return { id, at: createdAt > windowBegan(resets) ? resets : createdAt };
  });
}

/** What the staff call the owner. "the owner" until the install sets a name. */
export async function ownerName(q: Db = db): Promise<string> {
  const [row] = await q.select().from(owner).where(eq(owner.id, 'owner'));
  return row?.name.trim() || 'the owner';
}

/** Whether the owner has been through the office's welcome. */
export async function welcomed(): Promise<boolean> {
  const [row] = await db.select({ at: owner.welcomedAt }).from(owner).where(eq(owner.id, 'owner'));
  return !!row?.at;
}

/** The owner finished the welcome, under the name they gave. */
export async function finishWelcome(name: string): Promise<void> {
  await setOwnerName(name);
  await db.update(owner).set({ welcomedAt: new Date() }).where(eq(owner.id, 'owner'));
}

/** Set the owner's name. */
export async function setOwnerName(name: string): Promise<void> {
  const n = name.trim().slice(0, 30);
  if (!n) throw fixedError('Say a name');
  await db
    .insert(owner)
    .values({ id: 'owner', name: n, updatedAt: new Date() })
    .onConflictDoUpdate({ target: owner.id, set: { name: n, updatedAt: new Date() } });
}

/** The plan windows as last reported. A window past its reset reads as unused. */
export async function plan() {
  const [row] = await db.select().from(planLimits).where(eq(planLimits.id, PLAN_ROW));
  if (!row) return null;
  const now = new Date();
  const fresh = (used: number, resetsAt: Date | null) => (resetsAt && resetsAt <= now ? 0 : used);
  return {
    fiveHour: fresh(row.fiveHour, row.fiveHourResetsAt),
    fiveHourResetsAt: row.fiveHourResetsAt,
    sevenDay: fresh(row.sevenDay, row.sevenDayResetsAt),
    sevenDayResetsAt: row.sevenDayResetsAt,
    updatedAt: row.updatedAt
  };
}

export type UsageTotals = { tokens: number; output: number; costUsd: number; runs: number };
/** `at` is the bucket's start, in epoch milliseconds. */
export type UsageBucket = { at: number; tokens: number; output: number };

/** A staffer's tokens over the last day, week and month: totals and bars. */
export async function usageFor(staffId: string) {
  const totals = async (interval: string): Promise<UsageTotals> => {
    const [r] = await pg`
      select coalesce(sum(tokens), 0)::float8 as tokens,
             coalesce(sum(output_tokens), 0)::float8 as output,
             coalesce(sum(cost_usd), 0)::float8 as "costUsd",
             count(distinct created_at)::int as runs
      from usage
      where staff_id = ${staffId} and created_at > now() - ${interval}::interval`;
    return r as unknown as UsageTotals;
  };
  const tz = zone();
  // Buckets line up on the office's hours and days, so a bar reads as "Tuesday".
  const buckets = async (step: string, count: number, unit: 'hour' | 'day') =>
    (await pg`
      with b as (
        select generate_series(
          date_trunc(${unit}, now() at time zone ${tz}) - (${count - 1} * ${step}::interval),
          date_trunc(${unit}, now() at time zone ${tz}),
          ${step}::interval
        ) as start
      )
      select (extract(epoch from b.start at time zone ${tz}) * 1000)::float8 as at,
             coalesce(sum(u.tokens), 0)::float8 as tokens,
             coalesce(sum(u.output_tokens), 0)::float8 as output
      from b
      left join usage u
        on u.staff_id = ${staffId}
       and u.created_at at time zone ${tz} >= b.start
       and u.created_at at time zone ${tz} < b.start + ${step}::interval
      group by b.start
      order by b.start`) as unknown as UsageBucket[];
  const [d1, d7, d30, h24, w7, m30] = await Promise.all([
    totals('24 hours'),
    totals('7 days'),
    totals('30 days'),
    buckets('1 hour', 24, 'hour'),
    buckets('6 hours', 28, 'hour'),
    buckets('1 day', 30, 'day')
  ]);
  return { totals: { d1, d7, d30 }, series: { d1: h24, d7: w7, d30: m30 } };
}
