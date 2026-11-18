<script lang="ts">
  import { clockTime } from '@oddboro/ledger/time';
  import { call, type ApiUrl } from './api.ts';
  let { showWindow = true }: { showWindow?: boolean } = $props();

  // The Setup window's Updates section: the version this is, Check now, the
  // window updates install in, and a ready update with Install now and
  // Install tonight. It hears the server when an update lands, so nothing polls.
  type UpdateStatus = {
    ready: boolean;
    version: string | null;
    installAt: string | null;
    holding: boolean;
    current: string;
    managed: boolean;
    window: { start: string; end: string };
    checked: { at: string; result: 'none' | 'ready' | 'failed'; problem?: string } | null;
    checking: boolean;
  };
  let update = $state<UpdateStatus | undefined>();
  let start = $state('02:00');
  let end = $state('04:00');
  let busy = $state(false);
  let problem = $state('');

  async function load() {
    try {
      update = await call<UpdateStatus>('/api/update');
      start = update.window.start;
      end = update.window.end;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void load();
    const events = new EventSource('/api/events' satisfies ApiUrl);
    events.onmessage = (m) => {
      const e = JSON.parse(m.data) as { type: string; table?: string };
      if (e.type === 'change' && e.table === 'app_update') void load();
    };
    return () => events.close();
  });

  async function act(body: unknown, method?: string) {
    problem = '';
    busy = true;
    try {
      update = await call<UpdateStatus>('/api/update', body, method);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const saveWindow = () => {
    if (update && (start !== update.window.start || end !== update.window.end))
      void act({ start, end }, 'PUT');
  };

  const when = $derived(update?.installAt ? clockTime(new Date(update.installAt)) : '');
  const lastCheck = $derived.by(() => {
    const c = update?.checked;
    if (!c || c.result === 'ready') return '';
    const at = clockTime(new Date(c.at));
    return c.result === 'none'
      ? `Checked at ${at}. This is the newest version.`
      : `The check at ${at} failed: ${c.problem}`;
  });
  const field = 'rounded-lg bg-raise px-2 py-1.5 text-xs outline-none';
  const button =
    'rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20 disabled:opacity-40';
</script>

<section class="flex flex-col gap-2" aria-label="Updates">
  <div class="flex items-center">
    <h3 class="flex-1 text-xs tracking-[0.16em] text-sea uppercase">Updates</h3>
    {#if update?.managed && !update.ready}
      <button
        class="text-xs text-sea underline underline-offset-2 disabled:opacity-40"
        disabled={busy || update.checking}
        onclick={() => act({ action: 'check' })}
        >{update.checking ? 'Checking' : 'Check now'}</button
      >
    {/if}
  </div>
  {#if !update}
    <p class="text-xs text-muted">Looking up the version.</p>
  {:else}
    <p class="text-xs text-muted">
      {update.current === 'development'
        ? 'This is a development build. Only the Oddboro app updates itself.'
        : `This is Oddboro ${update.current}. Every update installs in your chosen window.`}
    </p>
    {#if update.ready}
      <div class="flex flex-col gap-2 rounded-lg bg-sea/15 px-3 py-2 text-xs">
        <p class="font-medium text-ink">Update ready: {update.version}</p>
        <p class="text-muted">
          {#if update.holding}
            Your Odds start nothing new and finish what they have. Oddboro then installs it and
            opens again.
          {:else}
            It installs at {when}. Your Odds stop starting new work 15 minutes before.
          {/if}
        </p>
        <div class="flex gap-2">
          <button
            class="rounded-lg bg-sea px-3 py-2 text-xs font-medium text-night disabled:opacity-40"
            disabled={busy || update.holding}
            onclick={() => act({ action: 'install-now' })}>Install now</button
          >
          <button class={button} disabled={busy} onclick={() => act({ action: 'install-tonight' })}
            >Install tonight</button
          >
        </div>
      </div>
    {:else if lastCheck}
      <p class="text-xs text-faint">{lastCheck}</p>
    {/if}
    {#if showWindow}
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Installs between</span>
        <input
          class={field}
          type="time"
          aria-label="Window start"
          bind:value={start}
          onchange={saveWindow}
        />
        <span>and</span>
        <input
          class={field}
          type="time"
          aria-label="Window end"
          bind:value={end}
          onchange={saveWindow}
        />
        <span>office time.</span>
      </div>
    {/if}
  {/if}
  {#if problem}
    <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
  {/if}
</section>
