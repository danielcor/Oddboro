<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    ProjectAgent,
    ProjectRequest,
    ProjectSession,
    ProjectStatus
  } from '@oddboro/ledger';
  import type { StaffProfile } from '../staff/roster.ts';
  import Pixel from './Pixel.svelte';
  import { projectApi } from './project-api.ts';
  import ProjectTerminal from './ProjectTerminal.svelte';
  import { LOGOS } from './tool-logos.ts';
  import type { ProjectAsk } from './windows.svelte.ts';

  // The Projects window, which widens the side panel while it is in front:
  // every session down the start side as a tab list, and the selected one
  // filling the rest, its native terminal under a slim header. Details fold out over the terminal,
  // so the terminal never moves. "+ New session" opens the start form here.
  type View = {
    connected: boolean;
    terminal: boolean;
    turn?: string;
    requestId?: string;
    note: string;
    reply: string;
    market?: string;
    account?: string;
    question?: {
      key: string;
      id: string | number;
      method: string;
      params: Record<string, unknown>;
    };
  };
  type Row = ProjectSession & { status: ProjectStatus; connected: boolean };
  type Choice = { id: string; title: string; live: boolean; updated: number; job?: string };
  type Props = {
    staff: StaffProfile[];
    /** Bumps when the office's records change, so the list reads again. */
    version: number;
    /** A session to open, from the Desk or a chat. `n` bumps on each ask. */
    ask: ProjectAsk;
  };
  let { staff, version, ask }: Props = $props();

  let connections = $state<Row[]>([]),
    currentId = $state<string>(),
    candidates = $state<Choice[]>([]),
    work = $state<ProjectRequest[]>([]),
    view = $state<View>();
  let socket = $state(''),
    folder = $state(''),
    agent = $state<ProjectAgent>('claude'),
    draft = $state(''),
    file = $state(''),
    name = $state(''),
    replies = $state<Record<string, string>>({});
  let busy = $state(false),
    problem = $state(''),
    handover = $state<Choice>(),
    found = $state(false),
    /** The details drawer, open over the terminal. */
    details = $state(false),
    /** The Odd waiting on the owner's second yes to send without asking. */
    unasked = $state<string>(),
    /** Whether this window's terminal view takes the typing. */
    writable = $state(false),
    copied = $state(false),
    loaded = $state(false);
  /** This window's terminal view. A new one per session opened. */
  let termView = $state(crypto.randomUUID());
  const selected = $derived(connections.find((s) => s.id === currentId));
  const terminalVisible = $derived(!!view?.connected && !!view.terminal);
  const TOOL: Record<ProjectAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
  const STATUS: Record<ProjectStatus, string> = {
    working: 'Working',
    waiting: 'Waiting for you',
    idle: 'Idle',
    done: 'Done'
  };
  /** Each request's state, as the owner reads it. */
  const STATE: Record<ProjectRequest['state'], string> = {
    proposed: 'Waiting for you',
    queued: 'Queued',
    authorized: 'Queued',
    sending: 'Sending',
    working: 'Working',
    done: 'Done',
    stopped: 'Stopped',
    uncertain: 'Check the conversation',
    failed: 'Failed'
  };
  const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const oddOf = (id: string | null) => staff.find((p) => p.id === id);
  /** What waits on the owner in the drawer: a native question, proposals and unclear deliveries. */
  const waitingCount = $derived(
    (view?.question ? 1 : 0) +
      work.filter((r) => r.state === 'proposed' || r.state === 'failed' || r.state === 'uncertain')
        .length
  );

  const describe = (e: unknown) => (e instanceof Error ? e.message : 'Could not reach the office.');
  function updates(stream: EventSource, id: string) {
    stream.addEventListener('session', (e) => {
      if (currentId !== id) return;
      const next: View = JSON.parse(e.data);
      // A new question from Codex opens the drawer where it is answered.
      if (next.question && next.question.key !== view?.question?.key) details = true;
      view = next;
    });
    stream.addEventListener('work', () => {
      if (currentId === id) void history(id).catch((e) => (problem = describe(e)));
    });
  }
  // The session's own updates, while no terminal view carries them.
  $effect(() => {
    const id = currentId;
    if (!id || terminalVisible) return;
    const stream = new EventSource('/api/project-sessions/' + id + '/events');
    updates(stream, id);
    return () => stream.close();
  });
  async function load() {
    connections = await projectApi<Row[]>('connections');
  }
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    problem = '';
    try {
      await fn();
    } catch (e) {
      problem = describe(e);
    } finally {
      busy = false;
    }
  }
  async function history(id: string) {
    const record = await projectApi<{ work: ProjectRequest[]; view: View }>('history', { id });
    if (currentId === id) {
      work = record.work;
      view = record.view;
      if (work.some((r) => r.state === 'failed' || r.state === 'uncertain')) details = true;
    }
  }
  async function select(id: string) {
    if (currentId === id) return;
    currentId = id;
    work = [];
    view = undefined;
    draft = '';
    file = '';
    replies = {};
    handover = undefined;
    unasked = undefined;
    writable = false;
    termView = crypto.randomUUID();
    await history(id);
    // Work waiting on the owner shows at once.
    details = work.some(
      (r) => r.state === 'proposed' || r.state === 'failed' || r.state === 'uncertain'
    );
  }
  function startNew() {
    currentId = undefined;
    view = undefined;
    work = [];
    found = false;
    candidates = [];
    handover = undefined;
    problem = '';
  }
  async function connect(choice?: Choice, handedOver = false) {
    const s = await projectApi<ProjectSession>('connect', {
      folder,
      agent,
      socket: (agent === 'codex' && socket.trim()) || undefined,
      nativeId: choice?.id,
      handedOver,
      title: choice?.title || name || undefined
    });
    await load();
    await select(s.id);
    if (agent === 'claude') await action('terminal');
  }
  async function search() {
    candidates = await projectApi<Choice[]>('find', {
      folder,
      agent,
      socket: (agent === 'codex' && socket.trim()) || undefined
    });
    found = true;
  }
  async function pick() {
    const r = await fetch('/api/folders/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ for: 'your project session' })
    });
    const b = await r.json();
    if (b.path) folder = b.path;
    else if (b.unavailable) throw new Error(b.unavailable);
  }
  async function action(op: string, fields: Record<string, unknown> = {}) {
    const id = currentId;
    if (!id) return;
    await projectApi(op, { id, ...fields });
    await Promise.all([history(id), load()]);
  }
  async function send() {
    const text = draft.trim();
    if (!text || !selected) return;
    const turn = view?.turn || (selected.agent === 'claude' ? view?.requestId : undefined);
    if (turn) await action('steer', { turn, prompt: text, file: file.trim() || undefined });
    else
      await action('send', {
        key: crypto.randomUUID(),
        prompt: text,
        file: file.trim() || undefined
      });
    draft = '';
    file = '';
  }
  async function reconnect() {
    if (!selected) return;
    folder = selected.folder;
    agent = selected.agent;
    const rows = await projectApi<Choice[]>('find', {
      folder,
      agent,
      socket: (agent === 'codex' && socket.trim()) || undefined
    });
    const choice = rows.find((x) => x.id === selected?.nativeId) ?? {
      id: selected.nativeId,
      title: selected.title,
      live: false,
      updated: 0
    };
    if (agent === 'codex' && !choice.live) {
      // Back to the start form, on this folder, to hand the conversation over.
      startNew();
      handover = choice;
    } else await connect(choice);
  }
  function choose(c: Choice) {
    if (agent === 'codex' && !c.live) {
      handover = c;
      return;
    }
    void run(() => connect(c));
  }
  async function copyId() {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.nativeId);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  // The list reads again whenever the office's records change.
  $effect(() => {
    void version;
    untrack(() =>
      load()
        .then(() => (loaded = true))
        .catch((e) => (problem = describe(e)))
    );
  });
  // The session asked for, else the newest, else the start form.
  $effect(() => {
    void ask.n;
    const want = ask.sessionId;
    if (!loaded) return;
    untrack(() => {
      const id = connections.find((s) => s.id === want)?.id ?? (currentId || connections[0]?.id);
      if (!id) return;
      void run(async () => {
        await select(id);
        // Opened from the Desk: what waits on the owner shows at once.
        if (id === want && waitingCount) details = true;
      });
    });
  });

  /** Up and Down move between sessions; Enter or Space opens one. */
  function rowKey(e: KeyboardEvent, i: number) {
    const rows = [...((e.currentTarget as HTMLElement).parentElement?.children ?? [])];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)] as HTMLElement | undefined;
      next?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (rows.at(e.key === 'Home' ? 0 : -1) as HTMLElement | undefined)?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void run(() => select(connections[i].id));
    }
  }
</script>

{#snippet logo(a: ProjectAgent, cls: string)}
  <svg class={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
    ><path fill-rule="evenodd" d={LOGOS[a]} /></svg
  >
{/snippet}

<section class="flex h-full min-h-0 flex-col text-sm" aria-label="Projects">
  <header class="flex items-center gap-3 border-b border-hairline px-3 py-2">
    <h2 class="font-pixel text-lg leading-none">Projects</h2>
    <span class="min-w-0 flex-1 truncate text-xs text-muted"
      >Claude Code and Codex in your own folders, with your permissions</span
    >
  </header>

  <div class="flex min-h-0 flex-1">
    <!-- The sessions, down the start side. The list scrolls on its own. -->
    <nav
      class="flex w-60 shrink-0 flex-col border-e border-hairline max-sm:w-40"
      aria-label="Sessions"
    >
      <button
        class="m-2 rounded-lg px-3 py-2 text-start text-xs font-medium {selected
          ? 'bg-raise text-ink hover:bg-sea/20'
          : 'bg-sea/25 text-ink'}"
        aria-pressed={!selected}
        onclick={startNew}>+ New session</button
      >
      <div
        class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2"
        role="listbox"
        aria-label="Project sessions"
      >
        {#each connections as s, i (s.id)}
          {@const odd = oddOf(s.staffId)}
          {@const on = s.id === currentId}
          <div
            class="flex cursor-pointer items-center gap-2 rounded-lg border-s-2 px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-sea {on
              ? 'border-sea bg-sea/20'
              : 'border-transparent hover:bg-raise'}"
            role="option"
            aria-selected={on}
            tabindex={on || (!currentId && i === 0) ? 0 : -1}
            onclick={() => run(() => select(s.id))}
            onkeydown={(e) => rowKey(e, i)}
          >
            {@render logo(s.agent, 'size-4 shrink-0 ' + (on ? 'text-ink' : 'text-muted'))}
            <span class="min-w-0 flex-1" title={s.folder}>
              <span class="block truncate text-[13px] {on ? 'text-ink' : 'text-ink/85'}"
                >{folderName(s.folder)}</span
              >
              <span class="block truncate text-[11px] text-muted">{s.title}</span>
              <span class="sr-only">{TOOL[s.agent]}, {STATUS[s.status]}</span>
            </span>
            {#if odd}
              <Pixel
                src={odd.look?.portrait}
                frame={`${odd.portrait}/default`}
                fallback={`${odd.sprite}@${odd.variant}/idle-down-0`}
                scale={1}
                label={s.sendsUnasked === odd.id
                  ? `${odd.name} sends work without asking`
                  : `${odd.name} may send work for your yes`}
                class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sea-deep {s.sendsUnasked ===
                odd.id
                  ? 'ring-1 ring-ember'
                  : ''}"
              />
            {/if}
            <span class="dot {s.status}" title={STATUS[s.status]} aria-hidden="true"></span>
          </div>
        {/each}
        {#if loaded && !connections.length}
          <p class="px-2 py-1 text-xs text-muted">No sessions yet.</p>
        {/if}
      </div>
    </nav>

    <!-- The selected session, or the start form. -->
    <div class="relative flex min-w-0 flex-1 flex-col">
      {#if !selected}
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <h3 class="text-xs tracking-[0.16em] text-sea uppercase">New session</h3>
          <label
            >Project folder <input
              class="field w-full"
              bind:value={folder}
              oninput={() => {
                found = false;
                candidates = [];
                handover = undefined;
              }}
              placeholder="Absolute folder path"
            /></label
          >
          <div class="flex flex-wrap gap-2">
            <button class="btn" onclick={() => run(pick)}>Choose folder</button>
            <select
              class="field"
              aria-label="Coding tool"
              bind:value={agent}
              onchange={() => {
                found = false;
                candidates = [];
                handover = undefined;
              }}
              ><option value="claude">Claude Code</option><option value="codex">Codex</option
              ></select
            >
          </div>
          {#if agent === 'codex'}<details>
              <summary class="cursor-pointer text-muted">Connect to a running Codex server</summary
              ><label
                >Private local socket <input
                  class="field w-full"
                  bind:value={socket}
                  placeholder="/path/to/private/codex.sock"
                  oninput={() => {
                    found = false;
                    candidates = [];
                    handover = undefined;
                  }}
                /></label
              >
              <p class="text-xs text-muted">
                Choose the socket used by the original Codex window. Leave it empty to use the
                office server.
              </p>
            </details>{/if}
          <label
            >Session name <input
              class="field w-full"
              bind:value={name}
              placeholder="Optional"
              maxlength="200"
            /></label
          >
          <div class="flex gap-2">
            <button class="btn" disabled={busy || !folder} onclick={() => run(() => connect())}
              >Start new</button
            ><button class="btn" disabled={busy || !folder} onclick={() => run(search)}
              >Find existing</button
            >
          </div>
          {#if found && !candidates.length}<p class="text-muted">
              No conversations found in this folder.
            </p>{/if}
          {#each candidates as c (c.id)}<button
              class="btn text-start"
              disabled={busy}
              onclick={() => choose(c)}
              >{c.title} · {c.live ? 'Running' : 'Saved'} · {new Date(c.updated).toLocaleString()} · {c.id.slice(
                0,
                8
              )}</button
            >{/each}
          {#if handover}<p>
              Finish or stop work in the previous Codex window before continuing this conversation
              here.
            </p>
            <button
              class="btn self-start"
              disabled={busy}
              onclick={() => run(() => connect(handover, true))}>Hand over this conversation</button
            >{/if}
          {#if problem}<p role="alert" class="text-coral">{problem}</p>{/if}
        </div>
      {:else}
        <!-- A slim header: what this is, and the few controls that act on it. -->
        <div class="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-xs">
          {@render logo(selected.agent, 'size-4 shrink-0 text-muted')}
          <strong class="max-w-56 truncate text-sm font-medium text-ink" title={selected.folder}
            >{folderName(selected.folder)}</strong
          >
          <span class="shrink-0 text-muted">{TOOL[selected.agent]}</span>
          <button
            class="shrink-0 rounded bg-raise px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink"
            title={`Copy the conversation ID ${selected.nativeId}`}
            aria-label="Copy the conversation ID"
            onclick={() => run(copyId)}>{copied ? 'Copied' : selected.nativeId.slice(0, 8)}</button
          >
          <span class="min-w-0 flex-1 truncate text-muted" aria-live="polite"
            >{view?.note ?? 'Loading session'}</span
          >
          {#if terminalVisible && !writable}
            <button
              class="btn shrink-0"
              onclick={() => run(() => projectApi('control', { id: selected?.id, view: termView }))}
              >Take control of terminal</button
            >
          {/if}
          <button
            class="btn shrink-0"
            class:on={details}
            aria-expanded={details}
            aria-controls="project-details"
            onclick={() => (details = !details)}
            >Details{#if waitingCount}<span class="ms-1 text-ember">{waitingCount}</span
              >{/if}</button
          >
          {#if view?.connected}
            <button
              class="btn shrink-0"
              disabled={busy}
              onclick={() => run(() => action('disconnect'))}>Disconnect</button
            >
          {:else if view}
            <button class="btn shrink-0" disabled={busy} onclick={() => run(reconnect)}
              >Reconnect</button
            >
          {/if}
        </div>

        <!-- The terminal fills what is left. The drawer opens over it. -->
        <div class="relative flex min-h-0 flex-1 flex-col">
          {#if terminalVisible}
            {#key termView}<ProjectTerminal
                onstream={updates}
                id={selected.id}
                view={termView}
                bind:writable
                onerror={(s) => (problem = s)}
              />{/key}
          {:else}
            <div class="grid flex-1 place-items-center p-6 text-center">
              <div class="flex flex-col items-center gap-2">
                {#if view?.connected}
                  <p class="text-muted">The terminal is closed.</p>
                  <button class="btn" disabled={busy} onclick={() => run(() => action('terminal'))}
                    >Open terminal</button
                  >
                {:else if view}
                  <p class="text-muted">This session is not connected to the office.</p>
                  <button class="btn" disabled={busy} onclick={() => run(reconnect)}
                    >Reconnect</button
                  >
                {:else}
                  <p class="text-muted">Loading session</p>
                {/if}
              </div>
            </div>
          {/if}
          {#if problem}
            <div
              role="alert"
              class="absolute inset-x-3 bottom-3 flex items-start gap-2 rounded-lg bg-panel-solid px-3 py-2 text-xs text-coral shadow-float"
            >
              <p class="flex-1">{problem}</p>
              <button
                class="text-muted hover:text-ink"
                aria-label="Dismiss"
                onclick={() => (problem = '')}>✕</button
              >
            </div>
          {/if}

          {#if details}
            <aside
              id="project-details"
              class="drawer absolute inset-y-0 end-0 flex w-[min(26rem,100%)] flex-col gap-3 overflow-y-auto border-s border-hairline p-3"
              aria-label="Session details"
            >
              <div class="flex items-center">
                <h3 class="flex-1 text-xs tracking-[0.16em] text-sea uppercase">Details</h3>
                <button
                  class="rounded-full px-2 py-0.5 text-muted hover:text-ink"
                  aria-label="Close details"
                  onclick={() => (details = false)}>✕</button
                >
              </div>
              <p class="text-xs break-all text-muted">
                {selected.title} · {selected.folder} · {selected.nativeId}
              </p>
              {#if view?.account}<p class="text-xs text-muted">
                  Codex sign-in at connection: {view.account}
                </p>{/if}

              {#if view?.question}<div class="flex flex-col gap-2 rounded-lg bg-ember/10 p-2">
                  <strong class="text-ink">Codex needs your answer</strong>
                  <pre class="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(
                      view.question.params,
                      null,
                      2
                    )}</pre>
                  {#if ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(view.question.method)}
                    <div class="flex gap-2">
                      <button
                        class="btn"
                        onclick={() =>
                          run(() =>
                            action('answer', {
                              request: view?.question?.id,
                              key: view?.question?.key,
                              pick: 'accept'
                            })
                          )}>Allow once</button
                      ><button
                        class="btn"
                        onclick={() =>
                          run(() =>
                            action('answer', {
                              request: view?.question?.id,
                              key: view?.question?.key,
                              pick: 'decline'
                            })
                          )}>Decline</button
                      >
                    </div>
                  {:else if view.question.method === 'item/tool/requestUserInput'}
                    {#each view.question.params.questions as { id: string; question: string; options?: { label: string }[]; isSecret?: boolean }[] as q (q.id)}
                      <label
                        >{q.question}<input
                          class="field w-full"
                          type={q.isSecret ? 'password' : 'text'}
                          bind:value={replies[q.id]}
                          placeholder={q.options?.map((o) => o.label).join(' / ')}
                        /></label
                      >
                    {/each}
                    <button
                      class="btn self-start"
                      onclick={() =>
                        run(async () => {
                          await action('answer', {
                            request: view?.question?.id,
                            key: view?.question?.key,
                            pick: 'accept',
                            answers: Object.fromEntries(
                              Object.entries(replies).map(([k, v]) => [k, [v]])
                            )
                          });
                          replies = {};
                        })}>Send answers</button
                    >
                  {:else}<p>Use the native terminal to review this request.</p>{/if}
                </div>{/if}

              {#if view?.connected}
                <form
                  class="flex flex-col gap-2"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void run(send);
                  }}
                >
                  <label
                    >{view.turn || (selected.agent === 'claude' && view.requestId)
                      ? 'Correction to the current work'
                      : 'Instruction'}
                    <textarea class="field w-full" rows="3" bind:value={draft}></textarea></label
                  >
                  <label
                    >Project file (optional)<input
                      class="field w-full"
                      bind:value={file}
                      placeholder="Path inside this project"
                    /></label
                  >
                  <div class="flex gap-2">
                    <button class="btn" disabled={busy || !draft.trim()}
                      >{view.turn || (selected.agent === 'claude' && view.requestId)
                        ? 'Send correction'
                        : 'Send instruction'}</button
                    >
                    {#if view.turn || view.requestId}<button
                        class="btn"
                        type="button"
                        onclick={() =>
                          run(() => action('stop', { expected: view?.turn || view?.requestId }))}
                        >Stop</button
                      >{/if}
                  </div>
                </form>
              {/if}
              {#if view?.reply}<pre class="whitespace-pre-wrap">{view.reply}</pre>{/if}

              <label
                >Odd allowed to send work with this session’s project tools
                <select
                  class="field w-full"
                  value={selected.staffId ?? ''}
                  disabled={busy}
                  onchange={(e) =>
                    run(() =>
                      action('share', { staffId: (e.target as HTMLSelectElement).value || null })
                    )}
                >
                  <option value="">Only me</option>{#each staff as s (s.id)}<option value={s.id}
                      >{s.name}</option
                    >{/each}
                </select>
              </label>
              {#if selected.staffId}
                {@const odd = oddOf(selected.staffId)?.name ?? 'This Odd'}
                <!-- Every assignment from an Odd waits for Take over and send, unless the owner ticks this. -->
                <label class="tick"
                  ><input
                    type="checkbox"
                    checked={selected.sendsUnasked === selected.staffId}
                    disabled={busy}
                    onchange={(e) => {
                      const box = e.target as HTMLInputElement;
                      const on = box.checked;
                      box.checked = !on;
                      if (on) unasked = selected?.staffId ?? undefined;
                      else void run(() => action('unasked', { staffId: null }));
                    }}
                  />Let {odd} send work without asking</label
                >
                {#if unasked === selected.staffId}<div
                    class="flex flex-col gap-2 rounded-lg bg-ember/10 p-2"
                    role="alertdialog"
                    aria-labelledby="unasked-warning"
                  >
                    <p id="unasked-warning" class="text-ink">
                      {odd} will send work into this session without asking you. It runs with your permissions.
                    </p>
                    <div class="flex gap-2">
                      <button
                        class="btn"
                        onclick={() =>
                          run(async () => {
                            await action('unasked', { staffId: unasked });
                            unasked = undefined;
                          })}>Let {odd} send</button
                      ><button class="btn" onclick={() => (unasked = undefined)}>Not now</button>
                    </div>
                  </div>{/if}
              {/if}

              {#if selected.agent === 'claude' && view?.market}
                <details>
                  <summary class="cursor-pointer text-xs text-muted">
                    Connect an existing Claude terminal to office assignments
                  </summary>
                  <p class="text-xs">
                    In that conversation, add the local marketplace, install its plugin, then reload
                    plugins. If it is already installed, update it with /plugin before reloading.
                    New sessions opened here load it at launch.
                  </p>
                  <pre
                    class="whitespace-pre-wrap break-all">/plugin marketplace add {JSON.stringify(
                      view.market
                    )} --scope local{'\n'}/plugin install oddboro-project-{selected.id}@oddboro-{selected.id} --scope local{'\n'}/reload-plugins</pre>
                </details>
              {/if}

              {#if work.length}
                <h3 class="text-xs tracking-[0.16em] text-sea uppercase">Requests</h3>
              {/if}
              {#each work as r (r.id)}<div
                  class="flex flex-col gap-1 border-t border-hairline pt-2"
                >
                  <strong class="text-[10px] tracking-[0.16em] text-ember uppercase"
                    >{STATE[r.state]}{#if r.staffId}<span class="text-faint">
                        · {oddOf(r.staffId)?.name ?? 'An Odd'}</span
                      >{/if}</strong
                  >
                  <p class="whitespace-pre-wrap">{r.prompt}</p>
                  {#if r.file}<p class="text-xs text-muted">Project file: {r.file}</p>{/if}
                  {#if r.answer}<p class="whitespace-pre-wrap text-muted">{r.answer}</p>{/if}
                  {#if r.state === 'proposed' || r.state === 'failed'}<p class="text-xs text-muted">
                      This runs with your permissions on this computer.
                    </p>
                    <div class="flex gap-2">
                      <button
                        class="btn"
                        onclick={() => run(() => action('decide', { key: r.id, approve: true }))}
                        >{r.state === 'failed' ? 'Retry assignment' : 'Take over and send'}</button
                      ><button
                        class="btn"
                        onclick={() => run(() => action('decide', { key: r.id, approve: false }))}
                        >Decline</button
                      >
                    </div>{/if}
                  {#if r.state === 'uncertain'}<button
                      class="btn self-start"
                      onclick={() => run(() => action('resolve', { key: r.id }))}
                      >I checked the native conversation</button
                    >{/if}
                </div>{/each}
            </aside>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--color-muted);
  }
  label.tick {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
  .btn {
    border-radius: 0.5rem;
    background: var(--color-raise);
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    color: var(--color-ink);
  }
  .btn:hover:not(:disabled),
  .btn.on {
    background: color-mix(in srgb, var(--color-sea) 25%, transparent);
  }
  .btn:disabled {
    opacity: 0.4;
  }
  .field {
    border-radius: 0.5rem;
    background: var(--color-raise);
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
    color: var(--color-ink);
    outline: none;
  }
  .field::placeholder {
    color: var(--color-faint);
  }
  option {
    background: var(--color-panel-solid);
  }
  pre {
    border-radius: 0.5rem;
    background: var(--color-night);
    padding: 0.5rem;
    font-size: 0.75rem;
  }
  /* Over the terminal, solid, so the terminal's text never shows through. */
  .drawer {
    background: var(--color-panel-solid);
    box-shadow: var(--shadow-float);
  }
  /* A session's status: working, waiting for you, its last work done, or idle. */
  .dot {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    flex-shrink: 0;
    border-radius: 9999px;
  }
  .dot.working {
    background: var(--color-sea);
  }
  .dot.waiting {
    background: var(--color-ember);
  }
  .dot.done {
    background: var(--color-moss);
  }
  .dot.idle {
    background: var(--color-faint);
  }
</style>
