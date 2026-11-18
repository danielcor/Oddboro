<script lang="ts">
  import { modelSection } from '@oddboro/ledger/access';
  import type { Check } from '@oddboro/ledger/checks';
  import AccountSection from './AccountSection.svelte';
  import AdvancedSection from './AdvancedSection.svelte';
  import BackupSection from './BackupSection.svelte';
  import { AgentTools } from './agent-tools.svelte.ts';
  import { call } from './api.ts';
  import DiagnosticsSection from './DiagnosticsSection.svelte';
  import OfficeTools from './OfficeTools.svelte';
  import SearchDownload from './SearchDownload.svelte';
  import { selectOnFocus } from './select-on-focus.ts';
  import UpdatesSection from './UpdatesSection.svelte';
  import WeatherSection from './WeatherSection.svelte';

  // The office's first screen for a new owner, and its Setup window after:
  // the name staff call them, the office they work in, their first staffer,
  // what the office runs on (the same list as setup's Your AI card), and the
  // same checks `npm run setup` runs.
  type Props = {
    office: string;
    welcomed: boolean;
    ondesign: () => void;
    onhire: () => void;
    onmeet: (id: string) => void;
    ondone: () => void;
    /** A notification when something new lands on the desk, per viewer. */
    notify: boolean;
    onnotify: (on: boolean) => void;
  };
  let { office, welcomed, ondesign, onhire, onmeet, ondone, notify, onnotify }: Props = $props();

  type Setup = {
    app: boolean;
    ownDatabase: boolean;
    checks: Check[];
    owner: string;
    zoneName: string;
    sample: boolean;
    staff: { id: string; name: string; role: string }[];
  };
  let setup = $state<Setup | undefined>();
  let name = $state('');
  let checking = $state(false);
  let saving = $state(false);
  let problem = $state('');
  const agentTools = new AgentTools();

  async function load() {
    checking = true;
    try {
      setup = await call<Setup>('/api/setup');
      if (!name) name = setup.owner;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
    }
  }
  $effect(() => {
    void load();
  });

  async function done() {
    problem = '';
    saving = true;
    try {
      await call('/api/setup', { name });
      ondone();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const MARK = { ok: '✓', optional: '!', missing: '✗' } as const;
  const TONE = { ok: 'text-moss', optional: 'text-ember', missing: 'text-coral' } as const;
  const missing = $derived(setup?.checks.filter((c) => c.state === 'missing') ?? []);
  const manager = $derived(setup?.staff.find((p) => p.role === 'Office Manager'));
  const field = 'w-full rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint';
</script>

{#snippet words(text: string)}
  {#each text.split('`') as part, i (i)}{#if i % 2}<code class="rounded bg-night/60 px-1"
        >{part}</code
      >{:else}{part}{/if}{/each}
{/snippet}

<section class="flex h-full min-h-0 flex-col" aria-label={welcomed ? 'Setup' : 'Welcome'}>
  <header class="border-b border-hairline p-3">
    <div class="font-pixel text-lg leading-none">{welcomed ? 'Setup' : 'Welcome'}</div>
    <div class="mt-1 text-xs text-muted">
      {welcomed
        ? 'Your name, your office, and what this computer has.'
        : 'Three things, and the office is yours.'}
    </div>
  </header>

  <div class="flex flex-1 flex-col gap-5 overflow-y-auto p-3 text-sm">
    <section class="flex flex-col gap-2">
      <h3 class="text-xs tracking-[0.16em] text-sea uppercase">1 · You</h3>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">What should your Odds call you?</span>
        <input
          class={field}
          placeholder="Your first name"
          maxlength="30"
          bind:value={name}
          {@attach selectOnFocus}
        />
      </label>
      {#if setup}
        <p class="text-xs text-muted">
          The office keeps {setup.zoneName}. Run {@render words('`npm run setup`')} to change it.
        </p>
      {/if}
      <label class="flex items-start gap-2">
        <input
          type="checkbox"
          class="mt-0.5"
          checked={notify}
          onchange={(e) => onnotify(e.currentTarget.checked)}
        />
        <span class="flex flex-col">
          <span class="text-xs text-ink">Notify me when something lands on my desk</span>
          <span class="text-xs text-muted"
            >A notification on this computer for each new ask, task or report, so you need not keep
            the office open in front of you.</span
          >
        </span>
      </label>
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-xs tracking-[0.16em] text-sea uppercase">2 · Your office</h3>
      <p class="text-xs text-muted">
        {#if setup?.sample}
          You are in {office}, the sample office. Describe the one you want, with the rooms and the
          feel you like, and the office draws it.
        {:else}
          You work in {office}. Redraw it whenever you like; your earlier layouts stay.
        {/if}
      </p>
      <button
        class="self-start rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
        onclick={ondesign}>{setup?.sample ? 'Design my office' : 'Open the Office window'}</button
      >
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-xs tracking-[0.16em] text-sea uppercase">3 · Your Odds</h3>
      {#if setup && !setup.staff.length}
        <p class="text-xs text-muted">
          Nobody works here yet. Say what the job is, and the office drafts the job description and
          draws the person.
        </p>
        <button
          class="self-start rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
          onclick={onhire}>Hire your first Odd</button
        >
      {:else if setup}
        <p class="text-xs text-muted">
          {setup.staff.length === 1 ? 'One Odd works' : `${setup.staff.length} Odds work`} here: {setup.staff
            .map((p) => p.name)
            .join(', ')}.
          {#if manager}{manager.name}, your Office Manager, helps you hire the rest.{/if}
        </p>
        <div class="flex gap-2">
          {#if manager}
            <button
              class="rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
              onclick={() => onmeet(manager.id)}>Meet {manager.name}</button
            >
          {/if}
          <button
            class="rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
            onclick={onhire}>Hire someone</button
          >
        </div>
      {/if}
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="text-xs tracking-[0.16em] text-sea uppercase">4 · Your AI</h3>
      <p class="text-xs text-muted">
        What your office runs on: its Office Manager and every new Odd. Each Odd can move to another
        tool on {modelSection('its')}.
      </p>
      <OfficeTools tools={agentTools} />
    </section>

    {#if welcomed}
      <UpdatesSection />
      <WeatherSection />
      <DiagnosticsSection />
      <AccountSection />
      {#if setup}
        <BackupSection app={setup.app} ownDatabase={setup.ownDatabase} />
      {/if}
      <AdvancedSection />
    {/if}

    <section class="flex flex-col gap-2">
      <div class="flex items-center">
        <h3 class="flex-1 text-xs tracking-[0.16em] text-sea uppercase">This computer</h3>
        <button
          class="text-xs text-sea underline underline-offset-2 disabled:opacity-40"
          disabled={checking}
          onclick={load}>{checking ? 'Checking' : 'Check again'}</button
        >
      </div>
      {#if !setup}
        <p class="text-xs text-muted">Checking what the office has.</p>
      {:else}
        {#if missing.length}
          <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">
            {missing.length === 1 ? 'One thing' : `${missing.length} things`} the office needs
            {missing.length === 1 ? 'is' : 'are'} missing. Your Odds cannot work until it is fixed.
          </p>
        {/if}
        <ul class="flex flex-col gap-1">
          {#each setup.checks as c, i (c.id)}
            <li class="rounded-lg bg-raise px-2.5 py-1.5 text-xs">
              <div class="flex gap-2">
                <span class="w-3 {TONE[c.state]}" aria-label={c.state}>{MARK[c.state]}</span>
                <span class="w-24 shrink-0 text-ink">{c.name}</span>
                <span class="min-w-0 flex-1 text-muted">{c.found}</span>
              </div>
              {#if c.download}
                <div class="ms-5 mt-1">
                  <SearchDownload
                    check={c}
                    ondone={(done) => setup && (setup.checks = setup.checks.with(i, done))}
                  />
                </div>
              {:else if c.fix && c.state !== 'ok'}
                <p class="ms-5 mt-1 text-faint">{@render words(c.fix)}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if problem}
      <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
    {/if}
  </div>

  <footer class="border-t border-hairline p-3">
    <button
      class="w-full rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
      disabled={!name.trim() || saving}
      onclick={done}>{welcomed ? 'Save' : 'Done'}</button
    >
  </footer>
</section>
