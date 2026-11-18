// Writing a ledger row, searching the ledger, and making every row's vector
// again once the search model arrives.
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql
} from 'drizzle-orm';
import { db } from './db.ts';
import { embed, EMBED_MODEL } from './embed.ts';
import { modelOnDisk } from './search-model.ts';
import { type Db } from './threads.ts';
import { ledger, type LedgerKind } from './schema.ts';
import type { LedgerRow } from './office.ts';

// The ledger

/** Write one ledger row, embedded on the way in. */
export async function record(
  e: {
    kind: LedgerKind;
    actor: string;
    title: string;
    body?: string;
    reason?: string | null;
    askId?: number;
    taskId?: number;
    runId?: number;
  },
  q: Db = db
): Promise<void> {
  const embedding = await embed(rowText(e), 'document');
  await q.insert(ledger).values({ ...e, embedding, embeddingModel: embedding && EMBED_MODEL });
}

/** The text a row's vector is made from. */
const rowText = (e: { title: string; body?: string; reason?: string | null }): string =>
  [e.title, e.body, e.reason].filter(Boolean).join('\n');

const ledgerColumns = {
  id: ledger.id,
  kind: ledger.kind,
  actor: ledger.actor,
  title: ledger.title,
  body: ledger.body,
  reason: ledger.reason,
  askId: ledger.askId,
  taskId: ledger.taskId,
  runId: ledger.runId,
  createdAt: ledger.createdAt
};

/** A row whose vector the search model made, so a search may compare it. */
const madeHere = () => and(isNotNull(ledger.embedding), eq(ledger.embeddingModel, EMBED_MODEL));
/** A row the search model has not made a vector for yet. */
const notMadeHere = () => or(isNull(ledger.embeddingModel), ne(ledger.embeddingModel, EMBED_MODEL));

/** Once true in a process, every row had its vector from the search model. */
let indexed = false;

/**
 * Whether a search may go by meaning: the model is here and every row has a
 * vector from it. Until the re-index has reached every row, the ledger is
 * searched by its words, so no row is missed.
 */
async function byMeaning(): Promise<boolean> {
  if (!modelOnDisk()) return false;
  if (indexed) return true;
  const [left] = await db.select({ id: ledger.id }).from(ledger).where(notMadeHere()).limit(1);
  indexed = !left;
  return indexed;
}

/** Search by meaning once the search model is here, by words until then. Newest first with no query. */
export async function searchLedger(
  query: string,
  opts: { kind?: LedgerKind; actor?: string; limit?: number } = {}
): Promise<LedgerRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const filters = [
    opts.kind ? eq(ledger.kind, opts.kind) : undefined,
    opts.actor ? eq(ledger.actor, opts.actor) : undefined
  ];
  if (!query.trim())
    return db
      .select(ledgerColumns)
      .from(ledger)
      .where(and(...filters))
      .orderBy(desc(ledger.createdAt))
      .limit(limit);
  const v = (await byMeaning()) ? await embed(query, 'query') : null;
  if (v)
    return db
      .select(ledgerColumns)
      .from(ledger)
      .where(and(...filters, madeHere()))
      .orderBy(cosineDistance(ledger.embedding, v))
      .limit(limit);
  return db
    .select(ledgerColumns)
    .from(ledger)
    .where(
      and(
        ...filters,
        sql`to_tsvector('english', ${ledger.title} || ' ' || ${ledger.body} || ' ' || coalesce(${ledger.reason}, '')) @@ websearch_to_tsquery('english', ${query})`
      )
    )
    .orderBy(desc(ledger.createdAt))
    .limit(limit);
}

/** The owner's past decisions closest to this text. */
export async function precedent(text: string, limit = 3): Promise<LedgerRow[]> {
  const v = (await byMeaning()) ? await embed(text, 'query') : null;
  if (!v) return searchLedger(text, { kind: 'decision', limit });
  return db
    .select(ledgerColumns)
    .from(ledger)
    .where(
      and(
        eq(ledger.kind, 'decision'),
        madeHere(),
        sql`${cosineDistance(ledger.embedding, v)} < 0.35`
      )
    )
    .orderBy(cosineDistance(ledger.embedding, v))
    .limit(limit);
}

/** Rows the re-index reads at a time. */
const BATCH = 32;
let reindexing: Promise<number> | undefined;

/**
 * Make the vector again for every row the search model has not made, in one
 * pass, oldest first, a batch at a time with a turn for everything else
 * between batches. It runs when the model arrives and as the office starts,
 * and does nothing when every row is done. Each row says which model made its
 * vector, so a pass the office stopped picks up where it left off. A row the
 * model cannot read ends the pass; the next start tries again. Resolves to the
 * number of rows it made. One pass runs at a time.
 */
export function reindexLedger(): Promise<number> {
  reindexing ??= reindex().finally(() => (reindexing = undefined));
  return reindexing;
}

async function reindex(): Promise<number> {
  if (!modelOnDisk()) return 0;
  let after = 0;
  let made = 0;
  for (;;) {
    const rows = await db
      .select({ id: ledger.id, title: ledger.title, body: ledger.body, reason: ledger.reason })
      .from(ledger)
      .where(and(gt(ledger.id, after), notMadeHere()))
      .orderBy(asc(ledger.id))
      .limit(BATCH);
    if (!rows.length) break;
    for (const r of rows) {
      const embedding = await embed(rowText(r), 'document');
      if (!embedding) return made;
      await db
        .update(ledger)
        .set({ embedding, embeddingModel: EMBED_MODEL })
        .where(eq(ledger.id, r.id));
      made++;
    }
    after = rows.at(-1)!.id;
    await nextTurn();
  }
  indexed = true;
  return made;
}
