<script lang="ts">
  import type { AskRow, Desk, LedgerRow, ReportRow, Step, TaskRow } from '@oddboro/ledger';
  import Pixel from './Pixel.svelte';
  import Markdown from './Markdown.svelte';
  import TaskResponse from './TaskResponse.svelte';
  import {
    current,
    drafts,
    finishWithResponse,
    writing,
    staleDraft
  } from './task-response.svelte.ts';
  import Attachments from './Attachments.svelte';
  import PostalMailbox from './PostalMailbox.svelte';
  import AwsSignIn from './AwsSignIn.svelte';
  import AwsSecretPick from './AwsSecretPick.svelte';
  import SelectToChat from './SelectToChat.svelte';
  import ReplyReview from './ReplyReview.svelte';
  import FilterReview from './FilterReview.svelte';
  import FolderAsk from './FolderAsk.svelte';
  import FolderWarning from './FolderWarning.svelte';
  import { call } from './api.ts';
  import { withActCheck } from './act-check.svelte.ts';
  import { AWS_GUIDES, siteLink } from '../site.ts';
  import { ago, when } from './format.ts';
  import { openFile, openProject, wins } from './windows.svelte.ts';
  import { chatAbout, replyAbout, showInChat } from './chat-about.svelte.ts';
  import { OFFICE_TOOLS } from '@oddboro/ledger/tools';
  import { describe } from '@oddboro/ledger/time';
  import { tickable, yesOrNo } from '@oddboro/ledger/tools';
  import type { DeskItem } from '@oddboro/ledger/desk-answers';
  import { untrack } from 'svelte';
  import GoalProposal from './GoalProposal.svelte';
  import { LEVEL_LABEL, type FolderAccess } from '@oddboro/ledger/access';
  import type { StaffProfile } from '../staff/roster.ts';
  import { chatAnswer, stepText, stepsToGo } from './task-steps.ts';
  import { yesSaid } from './yes-said.ts';

  type Props = {
    desk: Desk;
    staff: StaffProfile[];
    /** Open on this item when set, e.g. after clicking a waiting staffer. */
    focus?: string;
    /** Approving a proposed hire opens the hire window with it. */
    onhire: (a: AskRow) => void;
    /** Approving a goal plan opens a hire window for each hire in it. */
    onplan: (hires: AskRow[]) => void;
    /** Open a staffer's card, from the name on an item. */
    onstaff: (id: string) => void;
  };
  let { desk, staff, focus, onhire, onplan, onstaff }: Props = $props();

  /** The row each kind of desk item shows. */
  type DeskRow = { ask: AskRow; task: TaskRow; report: ReportRow };
  type Item = { [K in DeskItem]: { key: string; kind: K; at: string; row: DeskRow[K] } }[DeskItem];

  /**
   * The connect task an approved access ask just made, until the desk reloads
   * with it, so the open card turns into it at once.
   */
  let made = $state<TaskRow | undefined>();
  $effect(() => {
    if (made && desk.tasks.some((t) => t.id === made?.id)) made = undefined;
  });
  const tasks = $derived(
    made && !desk.tasks.some((t) => t.id === made?.id) ? [...desk.tasks, made] : desk.tasks
  );

  const items = $derived<Item[]>(
    [
      ...desk.asks.map((row) => ({
        key: `ask-${row.id}`,
        kind: 'ask' as const,
        at: String(row.createdAt),
        row
      })),
      ...tasks.map((row) => ({
        key: `task-${row.id}`,
        kind: 'task' as const,
        at: String(row.createdAt),
        row
      })),
      ...desk.reports.map((row) => ({
        key: `report-${row.id}`,
        kind: 'report' as const,
        at: String(row.createdAt),
        row
      }))
    ].sort((a, b) => a.at.localeCompare(b.at))
  );

  let openKey = $state<string | undefined>();
  /** An attached file with edits the owner has not saved. */
  let unsaved = $state(false);
  $effect(() => {
    wins.dirty.desk = unsaved;
  });

  /** Open an item, and select it in the chat of the staffer who delivered it. */
  function show(key: string | undefined) {
    openKey = key;
    unsaved = false;
    const i = items.find((x) => x.key === key);
    if (i?.row.staffId) showInChat(i.row.staffId, delivered(i));
  }
  const delivered = (i: Item) => ({ kind: i.kind, id: i.row.id, title: i.row.title });
  /** Moving off an item with unsaved edits waits for the owner to say so. */
  function go(key: string | undefined) {
    if (unsaved) wins.confirm = { id: 'desk', go: () => ((wins.confirm = undefined), show(key)) };
    else show(key);
  }
  // Only a new focus opens an item. `go` reads the desk, and a desk that
  // changes (a step ticked) must not reopen whatever was focused last.
  $effect(() => {
    const f = focus;
    if (f) untrack(() => go(f));
  });
  const attached = (kind: Exclude<DeskItem, 'report'>, id: number) =>
    desk.attachments.filter((f) => (kind === 'ask' ? f.askId : f.taskId) === id);
  const open = $derived(items.find((i) => i.key === openKey));
  const who = (id: string | null) => staff.find((p) => p.id === id);
  /** The open email replies, oldest first, which the review steps through. */
  const replies = $derived(desk.asks.filter((a) => a.kind === 'reply'));
  /** The open Gmail filters, oldest first, which their review steps through. */
  const filters = $derived(desk.asks.filter((a) => a.kind === 'filter'));
  /** What the list calls an item: a reply or a filter by its kind, else what it is. */
  const labelOf = (i: Item) =>
    i.kind === 'ask' && i.row.kind === 'reply'
      ? 'Reply'
      : i.kind === 'ask' && i.row.kind === 'filter'
        ? 'Filter'
        : LABEL[i.kind];
  /** The colleague whose work the lead raised an item from, if any. */
  const viaOf = (i: Item) => (i.kind === 'report' ? null : i.row.via);

  let busy = $state(false);
  let problem = $state('');
  let reason = $state('');
  let reportWhenDone = $state(false);
  let note = $state('');
  let precedent = $state<LedgerRow[]>([]);
  /** The ask this one reworks, when the owner sent that one back. */
  let reworks = $state<AskRow | null>(null);
  let secret = $state<Record<number, string>>({});
  let toolList = $state<Record<number, { name: string; description: string; readOnly: boolean }[]>>(
    {}
  );
  /** The parts of a goal plan the owner unticked. Every part starts ticked. */
  let skip = $state<Record<number, boolean>>({});
  /** A folder ask's folder and level as the owner will give them, and whether they are changing them. */
  let folderPath = $state('');
  let folderLevel = $state<FolderAccess>('read');
  let changing = $state(false);
  /** The server's warning on a whole drive or system files: Give access waits on Accept or Cancel. */
  let folderWarning = $state('');
  // A warning is about the folder and level it was given for: a change to either drops it.
  $effect(() => {
    void [folderPath, folderLevel];
    folderWarning = '';
  });

  // Each newly opened item starts clean, and an ask brings its closest past
  // decisions. Keyed on the item, not its row: the desk reloading (a step
  // ticked) must not wipe a half-typed note.
  $effect(() => {
    const key = openKey;
    const i = untrack(() => items.find((x) => x.key === key));
    reason = '';
    reportWhenDone = false;
    note = '';
    problem = '';
    precedent = [];
    reworks = null;
    skip = {};
    secret = {};
    changing = false;
    folderWarning = '';
    const asked = i?.kind === 'ask' ? i.row : undefined;
    folderPath = asked?.folder ? (untrack(() => desk.folders[asked.id]) ?? asked.folder.path) : '';
    folderLevel = asked?.folder?.level ?? 'read';
    if (i?.kind === 'ask')
      call<{ precedent: LedgerRow[]; revises: AskRow | null }>(`/api/asks/${i.row.id}`)
        .then((r) => {
          precedent = r.precedent;
          reworks = r.revises;
        })
        .catch(() => {});
  });

  async function act(fn: () => Promise<unknown>, close = false) {
    busy = true;
    problem = '';
    try {
      await fn();
      if (close) show(undefined);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const decide = (a: AskRow, decision: 'approve' | 'deny' | 'iterate') =>
    act(async () => {
      const picks = a.plan?.items.map((_, i) => i).filter((i) => !skip[i]);
      const send = (actsOnHandOffs?: boolean) =>
        call<{ hires?: AskRow[]; task?: TaskRow | null }>(`/api/asks/${a.id}`, {
          decision,
          reason,
          report: reportWhenDone,
          picks,
          actsOnHandOffs
        });
      // Raise to Act waits for the owner's Act check, the first time only,
      // then for their choice for work another Odd hands the Odd. An Odd
      // already at Act is not asked: the yes changes nothing.
      const odd = staff.find((s) => s.id === a.staffId);
      const raisesToAct =
        decision === 'approve' &&
        a.kind === 'level' &&
        a.level === 'act' &&
        odd?.permission !== 'act';
      const r = raisesToAct ? await withActCheck(odd?.name ?? a.staffId, send) : await send();
      if (!r) return;
      if (r.hires?.length) onplan(r.hires);
      // An approved access ask turns into the connect task it made, in place.
      if (r.task) made = r.task;
      show(r.task ? `task-${r.task.id}` : undefined);
    });
  /** A held call: the office makes that exact call, then the Odd carries on with what came back. */
  const makeCall = (a: AskRow) =>
    act(async () => {
      await call(`/api/asks/${a.id}/call`, {});
      show(undefined);
    });
  /** A held call's inputs, as the tool takes them, for the owner to read. */
  const inputs = (args: Record<string, unknown>) => JSON.stringify(args, null, 2);
  /**
   * Give the folder as it stands on the card: the server gives it, then
   * approves the ask. A whole drive or system files comes back as a warning
   * first, and goes only on Accept (`accept`).
   */
  const giveFolder = (a: AskRow, accept = false) =>
    act(async () => {
      const r = await call<{ warning?: string }>(`/api/asks/${a.id}/folder`, {
        path: folderPath,
        level: folderLevel,
        reason,
        accept
      });
      folderWarning = r.warning ?? '';
      if (!r.warning) show(undefined);
    });
  const picked = (a: AskRow) => a.plan?.items.filter((_, i) => !skip[i]).length ?? 0;
  const toolName = (id: string) => OFFICE_TOOLS.find((t) => t.id === id)?.name ?? id;
  const step = (t: TaskRow, index: number, body: Record<string, unknown>) =>
    act(() => call(`/api/tasks/${t.id}`, { index, ...body }));
  async function saveSecret(t: TaskRow, index: number) {
    await step(t, index, { op: 'secret', value: secret[index] });
    if (!problem) secret[index] = '';
  }
  const finish = (t: TaskRow, done: boolean) =>
    act(async () => {
      // Done saves the response the owner sees first, so the Odd gets those words.
      if (done) await finishWithResponse(t, { note });
      else await call(`/api/tasks/${t.id}`, { op: 'finish', done, note });
      made = undefined;
    }, true);

  /** Run now on a job that skipped a run: it runs, and leaves the While you were away card. */
  const runAway = (id: number) => act(() => call(`/api/jobs/${id}`, { op: 'run' }));
  /** Dismiss the While you were away card: every job on it leaves it. */
  const dismissAway = () => act(() => call('/api/jobs/away', undefined, 'DELETE'));

  /** The service's sign-in page opens in a new tab; the step ticks when the owner comes back. */
  async function hostedSignIn(t: TaskRow, index: number) {
    await act(async () => {
      const r = await call<{ url?: string }>(`/api/tasks/${t.id}`, { op: 'oauth', index });
      if (r.url) window.open(r.url, '_blank', 'noopener');
    });
  }

  async function loadTools(t: TaskRow, index: number) {
    await act(async () => {
      const r = await call<{ tools: { name: string; description: string; readOnly: boolean }[] }>(
        `/api/tasks/${t.id}`,
        { op: 'tools', index }
      );
      toolList[index] = r.tools;
    });
  }

  const LABEL = { ask: 'Ask', task: 'Task', report: 'Report' } as const;
  const doneCount = (steps: Step[]) => steps.filter((s) => s.done).length;
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Your desk">
  <!-- No heading: the window's tab already says Desk and how many wait. -->
  {#if open}
    <!-- Back to the list: its own row above the item, where the eye starts. -->
    <div class="border-b border-hairline px-3 py-2">
      <button
        class="flex items-center gap-1.5 rounded-lg bg-raise px-2.5 py-1 text-xs text-ink hover:bg-hairline"
        onclick={() => go(undefined)}
      >
        <svg
          class="size-3 rtl:-scale-x-100"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg
        >
        All items{items.length > 1 ? ` (${items.length})` : ''}
      </button>
    </div>
  {/if}

  {#if wins.confirm?.id === 'desk'}
    <div class="flex flex-wrap items-center gap-2 border-b border-hairline bg-ember/10 px-3 py-2">
      <span class="flex-1 text-xs text-ink">An attached file has unsaved changes.</span>
      <button
        class="rounded-lg bg-raise px-2.5 py-1 text-xs hover:bg-coral/25"
        onclick={() => wins.confirm?.go()}>Discard</button
      >
      <button
        class="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink"
        onclick={() => (wins.confirm = undefined)}>Keep editing</button
      >
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if !open}
      {#if desk.away.length}
        <section class="mb-3 rounded-xl bg-raise px-3 py-2.5" aria-label="While you were away">
          <div class="flex items-center gap-2">
            <h3 class="flex-1 text-sm font-medium text-ink">While you were away</h3>
            <button
              class="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink disabled:opacity-40"
              disabled={busy}
              onclick={dismissAway}>Dismiss</button
            >
          </div>
          <p class="mt-0.5 text-xs text-muted">
            {desk.away.length === 1
              ? 'This job skipped a run that was too late to be useful. It runs again at its next time.'
              : 'These jobs each skipped a run that was too late to be useful. Each runs again at its next time.'}
          </p>
          <ul class="mt-2 flex flex-col gap-1.5">
            {#each desk.away as j (j.id)}
              <li class="flex items-center gap-2">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm text-ink">{j.name}</span>
                  <span class="block text-[11px] text-faint"
                    >{who(j.staffId)?.name ?? j.staffId} · skipped {when(j.skippedAt)}</span
                  >
                </span>
                <button
                  class="shrink-0 rounded-lg bg-night/60 px-2.5 py-1 text-xs hover:bg-sea/25 disabled:opacity-40"
                  disabled={busy}
                  onclick={() => runAway(j.id)}>Run now</button
                >
              </li>
            {/each}
          </ul>
          {#if problem}
            <p class="mt-2 text-xs text-coral">{problem}</p>
          {/if}
        </section>
      {/if}
      {#if desk.projectWork.length}
        <ul class="mb-1.5 flex flex-col gap-1.5" aria-label="Project work to review">
          {#each desk.projectWork as p (p.id)}
            {@const from = p.staffId ? who(p.staffId) : undefined}
            <li>
              <button
                class="flex w-full items-start gap-3 rounded-xl bg-raise px-3 py-2.5 text-start transition-colors hover:bg-sea/15"
                onclick={() => openProject(p.sessionId)}
              >
                {#if from}
                  <Pixel
                    src={from.look?.portrait}
                    frame={`${from.portrait}/default`}
                    fallback={`${from.sprite}@${from.variant}/idle-down-0`}
                    scale={1}
                    label={from.name}
                    class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sea-deep"
                  />
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-[10px] tracking-[0.16em] uppercase">
                    <span class="text-ember">Project work</span>
                    <span class="text-faint">{from?.name ?? 'Office'} · {ago(p.at)}</span>
                  </span>
                  <span class="mt-0.5 block text-sm text-ink">{p.title}</span>
                  <span class="mt-0.5 block truncate text-xs text-muted">{p.prompt}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if !items.length && !desk.away.length && !desk.projectWork.length}
        <p class="py-10 text-center text-sm text-muted">
          Desk clear. Your Odds will bring you anything that needs you.
        </p>
      {/if}
      <ul class="flex flex-col gap-1.5">
        {#each items as i (i.key)}
          {@const from = who(i.row.staffId)}
          <li>
            <button
              class="flex w-full items-start gap-3 rounded-xl bg-raise px-3 py-2.5 text-start transition-colors hover:bg-sea/15"
              onclick={() => go(i.key)}
            >
              {#if from}
                <Pixel
                  src={from.look?.portrait}
                  frame={`${from.portrait}/default`}
                  fallback={`${from.sprite}@${from.variant}/idle-down-0`}
                  scale={1}
                  label={from.name}
                  class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sea-deep"
                />
              {/if}
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2 text-[10px] tracking-[0.16em] uppercase">
                  <span class={i.kind === 'report' ? 'text-sea' : 'text-ember'}>{labelOf(i)}</span>
                  <span class="text-faint"
                    >{from?.name ?? 'Office'}{viaOf(i)
                      ? `, from ${who(viaOf(i))?.name ?? viaOf(i)}'s work`
                      : ''} · {ago(i.at)}</span
                  >
                </span>
                <span class="mt-0.5 block text-sm text-ink">{i.row.title}</span>
                {#if i.kind === 'task' && i.row.steps.length}
                  <span class="mt-0.5 block text-xs text-muted"
                    >{doneCount(i.row.steps)} of {i.row.steps.length} steps done</span
                  >
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if desk.recent.length}
        <details class="mt-4 border-t border-hairline pt-2 text-xs text-muted">
          <summary class="cursor-pointer">Recent decisions and answers</summary>
          <ul class="mt-2 flex flex-col gap-2">
            {#each desk.recent as row (row.id)}
              <li>
                <span class="block text-ink">{row.title}</span>
                {#if row.reason}<span class="whitespace-pre-wrap">{row.reason}</span>{/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {:else if open.kind === 'ask' && open.row.kind === 'reply' && open.row.reply}
      {@const a = open.row}
      {#key a.id}
        <ReplyReview
          ask={{ ...a, reply: open.row.reply }}
          {replies}
          {staff}
          {reworks}
          ongo={(id) => go(id === undefined ? undefined : `ask-${id}`)}
          {onstaff}
        />
      {/key}
    {:else if open.kind === 'ask' && open.row.kind === 'filter' && open.row.filter}
      {@const a = open.row}
      {#key a.id}
        <FilterReview
          ask={{ ...a, filter: open.row.filter }}
          {filters}
          {staff}
          {reworks}
          ongo={(id) => go(id === undefined ? undefined : `ask-${id}`)}
          {onstaff}
        />
      {/key}
    {:else}
      {@const from = who(open.row.staffId)}
      {@const via = viaOf(open)}
      {#if from}
        <button
          class="mb-3 flex w-full items-center gap-3 rounded-xl bg-raise px-3 py-2.5 text-start transition-colors hover:bg-sea/15"
          title={`Open ${from.name}'s card`}
          onclick={() => onstaff(from.id)}
        >
          <Pixel
            src={from.look?.portrait}
            frame={`${from.portrait}/default`}
            fallback={`${from.sprite}@${from.variant}/idle-down-0`}
            scale={1}
            label={from.name}
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sea-deep"
          />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-ink">{from.name}</span>
            <span class="block text-xs text-muted">{from.role}</span>
            {#if from.remit}
              <span class="mt-0.5 block truncate text-[11px] text-faint">{from.remit}</span>
            {/if}
          </span>
        </button>
      {/if}
      <div class="text-[10px] tracking-[0.16em] uppercase">
        <span class={open.kind === 'report' ? 'text-sea' : 'text-ember'}>{LABEL[open.kind]}</span>
        <span class="text-faint"
          >· {from ? '' : 'Office · '}{#if from && via}{from.name}, from
            <button
              class="tracking-[0.16em] uppercase hover:text-ink"
              title={`Open ${who(via)?.name ?? via}'s chat`}
              onclick={() => chatAbout(via, '')}>{who(via)?.name ?? via}</button
            >'s work ·
          {/if}{when(open.at)}</span
        >
      </div>
      <h2 class="mt-1 text-base leading-snug font-medium">{open.row.title}</h2>

      {#if open.kind === 'ask'}
        {@const a = open.row}
        <dl class="mt-3 flex flex-col gap-3 text-sm">
          {#if reworks}
            <div class="rounded-lg bg-sea/10 px-2.5 py-2 text-xs">
              <div class="text-muted">Reworks “{reworks.title}”</div>
              {#if reworks.reason}<div class="mt-0.5">You asked: {reworks.reason}</div>{/if}
            </div>
          {/if}
          <div>
            <dt class="text-xs text-muted">Why</dt>
            <dd class="mt-0.5"><Markdown text={a.why} staff={a.staffId} /></dd>
          </div>
          {#if a.hire}
            {@const h = a.hire}
            <div>
              <dt class="text-xs text-muted">The hire</dt>
              <dd class="mt-1 flex flex-col gap-1 rounded-lg bg-raise px-2.5 py-2 text-xs">
                <div><span class="text-muted">Who:</span> {h.name}, {h.role}</div>
                <div><span class="text-muted">For:</span> {h.remit}</div>
                <div><span class="text-muted">Permission:</span> {LEVEL_LABEL[h.permission]}</div>
                {#if h.room}<div><span class="text-muted">Room:</span> {h.room}</div>{/if}
                {#if h.tools?.length}
                  <div>
                    <span class="text-muted">Office tools:</span>
                    {h.tools.map(toolName).join(', ')}
                  </div>
                {/if}
                {#if h.job}
                  <div>
                    <span class="text-muted">First job:</span>
                    {h.job.name}, {describe(h.job.schedule)}
                  </div>
                {/if}
                <div>
                  <span class="text-muted">Job description:</span>
                  <button
                    class="text-sea underline underline-offset-2"
                    onclick={() => openFile({ staff: a.staffId, path: h.jobDescriptionFile })}
                    >{h.jobDescriptionFile}</button
                  >
                </div>
              </dd>
            </div>
          {:else if a.goal || a.plan}
            <GoalProposal {a} {staff} {skip} onskip={(i, skipped) => (skip[i] = skipped)} />
          {:else if a.call}
            {@const c = a.call}
            {#snippet exact()}
              <dd class="mt-1 flex flex-col gap-1 rounded-lg bg-raise px-2.5 py-2 text-xs">
                <div><span class="text-muted">Tool:</span> {c.tool}</div>
                <div class="text-muted">Inputs:</div>
                <pre
                  class="max-h-72 overflow-auto rounded-md bg-night/50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">{inputs(
                    c.arguments
                  )}</pre>
              </dd>
            {/snippet}
            <div>
              {#if c.said && c.shown?.length}
                <!-- What it does in words, and each email it does it to, as Gmail showed them when it was held. -->
                <dt class="text-xs text-muted">{c.said}</dt>
                <dd class="mt-1 rounded-lg bg-raise px-2.5 py-2 text-xs">
                  <ul class="flex max-h-72 flex-col gap-1 overflow-y-auto">
                    {#each c.shown as item, n (n)}
                      <li class="break-words">{item}</li>
                    {/each}
                  </ul>
                </dd>
                <details class="mt-2">
                  <summary class="cursor-pointer text-xs text-muted hover:text-ink"
                    >The call, exactly as the office makes it</summary
                  >
                  {@render exact()}
                </details>
              {:else}
                <dt class="text-xs text-muted">The call, exactly as the office makes it</dt>
                {@render exact()}
              {/if}
              {#if c.before?.length}
                <!-- What this call may apply: the run's calls to the same service its standing yes let through. -->
                <details class="mt-2" open>
                  <summary class="cursor-pointer text-xs text-muted hover:text-ink"
                    >Made without asking before this call ({c.before.length})</summary
                  >
                  <ul class="mt-1 flex flex-col gap-1">
                    {#each c.before as b, n (n)}
                      <li class="rounded-lg bg-raise px-2.5 py-2 text-xs">
                        <div><span class="text-muted">Tool:</span> {b.tool}</div>
                        <pre
                          class="mt-1 max-h-48 overflow-auto rounded-md bg-night/50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">{inputs(
                            b.arguments
                          )}</pre>
                      </li>
                    {/each}
                  </ul>
                </details>
              {/if}
              <p class="mt-1.5 text-[11px] text-faint">
                Nothing has changed yet. Approve, and the office makes this call once, then {who(
                  a.staffId
                )?.name ?? 'the Odd'} carries on with what it returns.
              </p>
            </div>
          {:else if a.folder}
            <FolderAsk
              name={who(a.staffId)?.name ?? 'the Odd'}
              bind:path={folderPath}
              bind:level={folderLevel}
              bind:changing
            />
            {#if folderWarning}
              <FolderWarning
                folder={folderPath}
                warning={folderWarning}
                {busy}
                onaccept={() => giveFolder(a, true)}
                oncancel={() => (folderWarning = '')}
              />
            {/if}
          {:else}
            <div>
              <dt class="text-xs text-muted">If you approve</dt>
              <dd class="mt-0.5"><Markdown text={a.ifApproved} staff={a.staffId} /></dd>
            </div>
          {/if}
          {#if precedent.length}
            <div>
              <dt class="text-xs text-muted">Like this before</dt>
              <dd class="mt-1 flex flex-col gap-1">
                {#each precedent as p (p.id)}
                  <div class="rounded-lg bg-raise px-2.5 py-1.5 text-xs">
                    <div>{p.title}</div>
                    <div class="mt-0.5 text-faint">
                      {when(p.createdAt)} · {p.reason
                        ? `Your reason: ${p.reason}`
                        : 'No reason given'}
                    </div>
                  </div>
                {/each}
              </dd>
            </div>
          {/if}
        </dl>
        {#key open.key}
          <Attachments items={attached('ask', a.id)} ondirty={(d) => (unsaved = d)} />
        {/key}
        <label class="mt-4 block text-xs text-muted" for="reason"
          >{yesOrNo(a.kind) ? 'Reason' : 'Reason, or what to change'}</label
        >
        <textarea
          id="reason"
          rows="3"
          class="mt-1 w-full resize-y rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint"
          placeholder={yesOrNo(a.kind)
            ? 'Optional to approve or deny.'
            : 'Optional to approve or deny. Needed to iterate: say what to change.'}
          bind:value={reason}></textarea>
        {#if a.kind === 'approval'}
          <label class="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={reportWhenDone} /> Report when done
          </label>
          <p class="mt-1 text-[11px] text-faint">
            {who(a.staffId)?.name ?? 'The Odd'} starts as soon as you approve. You hear back if it fails
            or needs you{reportWhenDone ? ', and when it is done' : ''}.
          </p>
        {/if}
        <div class="mt-3 flex gap-2">
          <button
            class="flex-1 rounded-lg bg-raise px-3 py-2 text-sm font-medium hover:bg-coral/25 disabled:opacity-40"
            disabled={busy || unsaved}
            onclick={() => decide(a, 'deny')}>{a.kind === 'window' ? 'Pause it' : 'Deny'}</button
          >
          {#if !yesOrNo(a.kind)}
            <button
              class="flex-1 rounded-lg bg-raise px-3 py-2 text-sm font-medium hover:bg-sea/25 disabled:opacity-40"
              disabled={busy || unsaved || !reason.trim()}
              title={reason.trim() ? '' : 'Say what to change in the box above first'}
              onclick={() => decide(a, 'iterate')}>{a.folder ? 'Send back' : 'Iterate'}</button
            >
          {/if}
          {#if a.folder}
            {#if !changing}
              <button
                class="flex-1 rounded-lg bg-raise px-3 py-2 text-sm font-medium hover:bg-sea/25 disabled:opacity-40"
                disabled={busy || unsaved}
                onclick={() => (changing = true)}>Change</button
              >
            {/if}
            <button
              class="flex-[1.4] rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
              disabled={busy || unsaved || !folderPath.trim() || !!folderWarning}
              onclick={() => giveFolder(a)}>Give access</button
            >
          {:else if a.kind === 'hire'}
            <button
              class="flex-[1.4] rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
              disabled={busy || unsaved}
              onclick={() => onhire(a)}>Open hire window</button
            >
          {:else}
            <button
              class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
              disabled={busy || unsaved || (a.kind === 'plan' && !picked(a))}
              onclick={() => (a.kind === 'call' ? makeCall(a) : decide(a, 'approve'))}
              >{yesSaid(a, { picked: picked(a), busy })}</button
            >
          {/if}
        </div>
        {#if a.access}
          <p class="mt-1.5 text-[11px] text-faint">
            Connect gives {who(a.staffId)?.name ?? 'the Odd'} access. Any steps to connect it open right
            here.
          </p>
        {/if}
        {#if a.folder}
          <p class="mt-1.5 text-[11px] text-faint">
            Give access gives {who(a.staffId)?.name ?? 'the Odd'} this folder, and it starts on the work
            that waited for it. Change lets you pick a smaller folder or Can read first.
          </p>
        {/if}
        {#if !yesOrNo(a.kind)}
          <p class="mt-1.5 text-[11px] text-faint">
            {a.folder ? 'Send back' : 'Iterate'} sends it back to {who(a.staffId)?.name ??
              'the Odd'} with your words, and the new version comes back to your desk.
          </p>
        {/if}
      {:else if open.kind === 'task'}
        {@const t = open.row}
        <p class="mt-2 text-sm leading-relaxed text-muted">{t.why}</p>
        {@const toGo = stepsToGo(t.steps)}
        {@const response = current(t)}
        {@const draft = drafts[t.id]}
        {@const needsSave = !!draft || (response.response !== null && !response.responseVersion)}
        {@const blockedResponse =
          writing[t.id] ||
          staleDraft(draft, response) ||
          (needsSave && !(draft?.text ?? response.response)?.trim())}
        {@const how = chatAnswer(
          { ...t, response: response.response },
          attached('task', t.id).length > 0
        )}
        <!-- A question with one answer has no steps: its answer goes in the response below. -->
        <ol class="mt-3 flex flex-col gap-2" class:hidden={!t.steps.length}>
          {#each t.steps as s, index (index)}
            <li
              class="flex gap-2.5 rounded-xl bg-raise px-3 py-2.5 text-sm"
              class:opacity-60={s.done}
            >
              <span class="font-pixel text-faint">{index + 1}.</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-start gap-2">
                  {#if tickable(s)}
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={s.done}
                      disabled={busy}
                      aria-label={s.done ? `Undo step ${index + 1}` : `Mark step ${index + 1} done`}
                      onchange={() => step(t, index, { op: s.done ? 'untick' : 'tick' })}
                    />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <Markdown
                      text={stepText(s.text)}
                      staff={t.staffId ?? undefined}
                      copyCode
                      class={s.done ? 'line-through' : ''}
                    />
                    {#if s.action?.kind === 'aws' && !s.done && AWS_GUIDES[s.action.connector]}
                      {@const guide = AWS_GUIDES[s.action.connector]}
                      <p class="mt-1 leading-relaxed">
                        New to this?
                        <a
                          class="text-sea underline hover:text-ink"
                          href={siteLink(guide.path)}
                          target="_blank"
                          rel="noopener">{guide.label}, step by step</a
                        >: the role, and where to find each of these.
                      </p>
                    {/if}
                  </div>
                  <!-- A chosen mailbox changes only by revoking its grants, so its step has no Undo. -->
                  {#if s.done && !tickable(s) && s.action?.kind !== 'postal'}
                    <button
                      class="ms-auto shrink-0 text-xs text-muted underline hover:text-ink disabled:opacity-40"
                      disabled={busy}
                      onclick={() => step(t, index, { op: 'untick' })}>Undo</button
                    >
                  {/if}
                </div>
                {#if s.action?.kind === 'oauth' && !s.done}
                  <button
                    class="mt-2 rounded-lg bg-sea px-3 py-1.5 text-xs font-medium text-night disabled:opacity-40"
                    disabled={busy}
                    onclick={() => hostedSignIn(t, index)}>Sign in</button
                  >
                  <details class="mt-2 text-xs text-muted">
                    <summary class="cursor-pointer">The service won't let me sign in</summary>
                    <p class="mt-2">
                      If your organization blocks the app, check with the person who manages the
                      account. Once they approve it, return here and click Sign in.
                    </p>
                    {#if s.action.google}
                      <p class="mt-2">
                        If Google says Oddboro is limited to test users or has reached its user
                        limit, open an Odd's chat and choose More, then Report a bug. Include the
                        error message only. The report is public.
                      </p>
                    {/if}
                  </details>
                {:else if s.action?.kind === 'postal'}
                  {#if s.done}
                    {#if s.answer}<p class="mt-1.5 text-xs text-muted">{s.answer}</p>{/if}
                  {:else}
                    {#key t.id}<PostalMailbox
                        taskId={t.id}
                        {index}
                        odd={who(t.staffId)?.name ?? 'the Odd'}
                      />{/key}
                  {/if}
                {:else if s.action?.kind === 'aws'}
                  {#if s.done}
                    {#if s.answer}<p class="mt-1.5 text-xs text-muted">{s.answer}</p>{/if}
                  {:else}
                    <AwsSignIn taskId={t.id} {index} connector={s.action.connector} />
                  {/if}
                {:else if s.action?.kind === 'secret' && !s.done}
                  <div class="mt-2 flex gap-2">
                    <input
                      type="password"
                      class="min-w-0 flex-1 rounded-lg bg-night/60 px-2.5 py-1.5 text-xs outline-none"
                      placeholder={s.action.name === 'Authorization' ? 'API key' : s.action.name}
                      bind:value={secret[index]}
                    />
                    <button
                      class="rounded-lg bg-sea px-3 py-1.5 text-xs font-medium text-night disabled:opacity-40"
                      disabled={busy || !secret[index]?.trim()}
                      onclick={() => saveSecret(t, index)}>Save</button
                    >
                  </div>
                  <AwsSecretPick taskId={t.id} {index} />
                {:else if s.action?.kind === 'secret' && s.answer}
                  <p class="mt-1.5 text-xs text-muted">{s.answer}</p>
                {:else if s.action?.kind === 'tools' && !s.done}
                  {#if !toolList[index]}
                    <button
                      class="mt-2 rounded-lg bg-sea px-3 py-1.5 text-xs font-medium text-night disabled:opacity-40"
                      disabled={busy}
                      onclick={() => loadTools(t, index)}>{busy ? 'Connecting' : 'Connect'}</button
                    >
                  {:else}
                    {@const list = toolList[index]}
                    <p class="mt-2 text-xs text-muted">
                      {#if list.some((tool) => tool.readOnly)}
                        Read only reaches the tools marked reads only: the ones the service says
                        only read, less any whose name says it changes something. Read and write
                        reaches every tool.
                      {:else if list.length}
                        None of these tools only read, so a Read only grant reaches none of them.
                        Read and write reaches every tool. To share a saved result instead,
                        <a
                          class="text-sea underline"
                          href={siteLink('/info/folder-sharing/')}
                          target="_blank"
                          rel="noreferrer">give the Odd a folder it can read</a
                        >.
                      {:else}
                        The service returned no tools. Check the account and its access, then
                        reconnect.
                      {/if}
                    </p>
                    <ul class="mt-1.5 flex max-h-48 flex-col gap-1 overflow-y-auto">
                      {#each list as tool (tool.name)}
                        <li class="text-xs">
                          <code class="text-sea">{tool.name}</code>
                          {#if tool.readOnly}<span class="text-moss"> reads only</span>{:else}<span
                              class="text-faint"
                            >
                              Read and write only</span
                            >{/if}
                          <span class="block text-faint">{tool.description.slice(0, 120)}</span>
                        </li>
                      {/each}
                    </ul>
                    <button
                      class="mt-2 rounded-lg bg-sea px-3 py-1.5 text-xs font-medium text-night disabled:opacity-40"
                      disabled={busy}
                      onclick={() => step(t, index, { op: 'confirm-tools' })}>Confirm</button
                    >
                  {/if}
                {:else if s.action?.kind === 'choice'}
                  {#if s.answer}
                    <div class="mt-1.5 text-xs text-sea">You chose: {s.answer}</div>
                  {:else}
                    <div class="mt-2 flex flex-col gap-1.5" role="group" aria-label="Choices">
                      {#each s.action.options as option (option)}
                        <button
                          class="choice"
                          disabled={busy}
                          onclick={() => step(t, index, { op: 'choose', answer: option })}
                          >{option}</button
                        >
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
            </li>
          {/each}
        </ol>
        {#key open.key}
          {#if t.staffId && !t.askId}
            <TaskResponse
              task={t}
              odd={who(t.staffId)?.name}
              files={attached('task', t.id)}
              open={!!how && !how.choice}
            />
          {/if}
          <Attachments
            items={attached('task', t.id)}
            reference={response.response !== null}
            start="edit"
            ondirty={(d) => (unsaved = d)}
          />
        {/key}
        <label class="mt-4 block text-xs text-muted" for="note">Note (optional)</label>
        <textarea
          id="note"
          rows="2"
          class="mt-1 w-full resize-none rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint"
          placeholder="Anything your Odds should know"
          bind:value={note}></textarea>
        <!-- A connect-only ask's task starts no work of its own: the proposal it serves does. -->
        {#if from && !desk.connectOnly.includes(t.id)}
          <p class="mt-2 text-[11px] text-faint">
            {from.name} picks up from here as soon as you mark it done.
          </p>
        {/if}
        <div class="mt-3 flex gap-2">
          <button
            class="rounded-lg bg-raise px-3 py-2 text-sm text-muted hover:text-ink disabled:opacity-40"
            disabled={busy || unsaved}
            onclick={() => finish(t, false)}>Drop it</button
          >
          <button
            class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
            disabled={busy || unsaved || blockedResponse || toGo > 0}
            onclick={() => finish(t, true)}
            >{unsaved
              ? 'Save the attached file first'
              : toGo
                ? `${toGo} ${toGo === 1 ? 'step' : 'steps'} to go`
                : needsSave
                  ? 'Save and finish'
                  : 'Mark done'}</button
          >
        </div>
      {:else}
        {@const r = open.row}
        <SelectToChat {staff} author={r.staffId} what={`report "${r.title}"`}>
          <Markdown text={r.body} staff={r.staffId} class="mt-3 text-sm" />
        </SelectToChat>
        <p class="mt-2 text-[11px] text-faint">
          Select any part of it to chat with an Odd about it.
        </p>
        <p class="mt-4 text-[11px] text-faint">
          Feedback goes to {from?.name ?? 'the Odd'} as a reply in their chat. Replying marks it read.
        </p>
        <div class="mt-2 flex gap-2">
          {#if r.staffId}
            {@const author = r.staffId}
            <button
              class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night"
              onclick={() => replyAbout(author, { kind: 'report', id: r.id, title: r.title })}
              >Reply to {from?.name ?? 'them'}</button
            >
          {/if}
          <button
            class="rounded-lg bg-raise px-3 py-2 text-sm text-muted hover:text-ink disabled:opacity-40"
            disabled={busy}
            onclick={() => act(() => call(`/api/reports/${r.id}`, {}), true)}>Read</button
          >
        </div>
      {/if}
      {#if problem}
        <p class="mt-3 rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
      {/if}
    {/if}
  </div>
</section>
