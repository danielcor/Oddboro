<script lang="ts">
  import { call, stream } from '../api.ts';

  // How Odds on Claude Code think, under the tool list on setup's Your AI
  // card (AiCard.svelte). Two tabs: a Claude plan, which says the account the
  // office's own Claude Code folder (its Office account) is signed in to and
  // signs it in, again or out, or an API key kept in the keychain. An office
  // made before it had its own folder runs on the owner's own login until
  // then, and the card says so. Either way, a model: Opus or Sonnet. Sonnet
  // cannot draw looks or design offices, and the card says so.
  type Model = 'opus' | 'sonnet';
  type Settings = {
    auth: 'plan' | 'key';
    model: Model;
    account?: { email?: string; org?: string; plan?: string };
    /** The owner's own login, which Odds use until the office's own folder is signed in. */
    ownLogin?: { email?: string };
    /** A sign-in is waiting on its page, maybe from before this page loaded. */
    signingIn?: boolean;
  };
  type Props = {
    /** Open on the API key tab. */
    wantKey?: boolean;
    /** The model staff run on, for the cards after this one. */
    onmodel: (m: Model) => void;
    /** Whether Odds can run: signed in on the plan, or a key in use. */
    onready: (ready: boolean) => void;
  };
  let { wantKey = false, onmodel, onready }: Props = $props();

  let settings = $state<Settings | undefined>();
  let tab = $state<'plan' | 'key'>('plan');
  let key = $state('');
  let saving = $state(false);
  let switching = $state(false);
  /** Counts sign-ins, so one that was started over or cancelled no longer changes the card. */
  let attempt = 0;
  let problem = $state('');
  const waiting = $derived(switching || !!settings?.signingIn);

  const tell = (s: Settings) => {
    onmodel(s.model);
    onready(s.auth === 'key' || !!s.account);
  };
  const load = async () => {
    settings = await call<Settings>('/api/setup/claude');
    tell(settings);
  };
  $effect(() => {
    void load().then(() => (tab = wantKey || settings?.auth === 'key' ? 'key' : 'plan'));
  });

  async function save(change: Record<string, unknown>) {
    problem = '';
    saving = true;
    try {
      settings = await call<Settings>('/api/setup/claude', change, 'PUT');
      tell(settings);
      if ('key' in change) key = '';
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  /**
   * Sign Claude Code in to another account; the page that opens finishes it.
   * Pressed again while one waits, it starts over with a fresh page.
   */
  /** Sign the office's own folder out. The owner's own Claude login is never touched. */
  async function signOut() {
    saving = true;
    problem = '';
    try {
      await call('/api/agents/claude', { action: 'sign-out' });
      await load();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function switchAccount() {
    problem = '';
    const mine = ++attempt;
    switching = true;
    try {
      await stream<{ done?: boolean }>('/api/setup/claude', { action: 'sign-in' }, () => {});
    } catch (e) {
      if (mine === attempt) problem = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === attempt) {
        switching = false;
        await load();
      }
    }
  }

  /** Stop a sign-in that is waiting, from this page or one before a refresh. */
  async function cancelSignIn() {
    attempt++;
    switching = false;
    problem = '';
    try {
      await call('/api/setup/claude', undefined, 'DELETE');
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    await load();
  }

  const MODELS = [
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' }
  ] as const;
  /** "Max plan, Acme" from what Claude Code reports. */
  const plan = $derived(
    [
      settings?.account?.plan &&
        `${settings.account.plan[0].toUpperCase()}${settings.account.plan.slice(1)} plan`,
      settings?.account?.org
    ]
      .filter(Boolean)
      .join(', ')
  );
  const TABS = [
    { id: 'plan', label: 'Claude plan' },
    { id: 'key', label: 'API key' }
  ] as const;
</script>

{#snippet models()}
  <div class="border-t border-hairline p-3">
    <div class="text-[10px] tracking-[0.14em] text-muted uppercase" id="onboarding-model">
      Model
    </div>
    <div
      class="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-night/40 p-1"
      role="radiogroup"
      aria-labelledby="onboarding-model"
    >
      {#each MODELS as m (m.label)}
        <button
          class="model"
          role="radio"
          aria-checked={settings?.model === m.id}
          class:on={settings?.model === m.id}
          disabled={saving || !settings}
          onclick={() => save({ model: m.id })}
        >
          {m.label}
        </button>
      {/each}
    </div>
    {#if settings?.model === 'sonnet'}
      <p class="mt-2 rounded-lg bg-ember/15 px-3 py-2 text-xs text-ember" role="alert">
        On Sonnet, the office cannot draw looks for new Odds or design offices. Those need Opus. You
        can still pick a ready-made manager and move into Main Street (our default layout).
      </p>
    {/if}
  </div>
{/snippet}

<!-- A sign-in finished on its own page shows here when the owner comes back. -->
<svelte:window onfocus={() => waiting && !switching && void load()} />

<div class="flex gap-1 border-b border-hairline" role="tablist" aria-label="How Odds reach Claude">
  {#each TABS as t (t.id)}
    <button
      class="tab"
      role="tab"
      aria-selected={tab === t.id}
      class:on={tab === t.id}
      onclick={() => (tab = t.id)}
      >{t.label}{#if settings?.auth === t.id}<span class="ms-1.5 text-sea" aria-label="in use"
          >●</span
        >{/if}</button
    >
  {/each}
</div>

<div class="mt-3 overflow-hidden rounded-xl bg-raise" role="tabpanel">
  {#if tab === 'plan'}
    <div class="p-3">
      <div class="text-[10px] tracking-[0.14em] text-muted uppercase">Signed in as</div>
      {#if waiting}
        <p class="mt-1 text-sm text-muted">Finish signing in on the page that opened.</p>
      {:else if settings?.account}
        <p class="mt-1 font-medium break-all">{settings.account.email ?? 'Your account'}</p>
        {#if plan}
          <p class="text-xs text-muted">{plan}</p>
        {/if}
      {:else if settings?.ownLogin}
        <p class="mt-1 text-sm text-muted">
          Your office does not have its own Claude sign-in yet. Your Odds use your own login, {settings
            .ownLogin.email ?? 'on this computer'}, until you sign the office in. It takes one
          click.
        </p>
      {:else if settings}
        <p class="mt-1 text-sm text-muted">Claude Code is not signed in for this office.</p>
      {:else}
        <p class="mt-1 text-sm text-muted">Checking which account Claude Code uses.</p>
      {/if}
    </div>
    {@render models()}
    {#if settings?.auth === 'key'}
      <button class="wide" disabled={saving} onclick={() => save({ auth: 'plan' })}>
        Use my Claude plan instead of the key
      </button>
    {:else if waiting}
      <button class="wide" onclick={switchAccount}>Open the sign-in page again</button>
      <button class="wide" onclick={cancelSignIn}>Cancel signing in</button>
    {:else}
      <button class="wide" onclick={switchAccount}
        >{settings?.account ? 'Switch account' : 'Sign in to Claude Code'}</button
      >
      {#if settings?.account}
        <button class="wide" disabled={saving} onclick={signOut}>Sign out</button>
      {/if}
    {/if}
  {:else}
    <form
      class="p-3"
      novalidate
      onsubmit={(e) => {
        e.preventDefault();
        if (key.trim()) void save({ key });
      }}
    >
      <label class="text-[10px] tracking-[0.14em] text-muted uppercase" for="onboarding-key">
        {settings?.auth === 'key' ? 'Replace your key' : 'Anthropic API key'}
      </label>
      {#if settings?.auth === 'key'}
        <p class="mt-1 text-sm">Your Odds run on the key in this computer's password store.</p>
      {/if}
      <div class="mt-2 flex gap-2">
        <input
          id="onboarding-key"
          class="field min-w-0 flex-1"
          type="password"
          placeholder="sk-ant-..."
          autocomplete="off"
          spellcheck="false"
          bind:value={key}
        />
        <button class="btn" disabled={!key.trim() || saving}
          >{saving ? 'Trying it' : 'Use this key'}</button
        >
      </div>
      <p class="mt-2 text-xs text-faint">
        The office tries the key once, then keeps it in this computer's password store, never in a
        file. Usage bills to the key's Anthropic Console account.
      </p>
    </form>
    {@render models()}
  {/if}
</div>

{#if problem}
  <p class="mt-3 rounded-lg bg-coral/15 px-3 py-2 text-sm text-coral">{problem}</p>
{/if}

<style>
  .tab {
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    padding: 0.4rem 0.75rem;
    font-size: 0.875rem;
    color: var(--color-muted);
  }
  .tab:hover {
    color: var(--color-ink);
  }
  .tab.on {
    border-bottom-color: var(--color-sea);
    color: var(--color-ink);
  }
  .model {
    border-radius: 0.5rem;
    padding: 0.45rem 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-muted);
  }
  .model:hover {
    color: var(--color-ink);
  }
  .model.on {
    background: var(--color-raise);
    color: var(--color-ink);
    box-shadow: inset 0 0 0 1px var(--color-sea);
  }
  .wide {
    display: block;
    width: 100%;
    border-top: 1px solid var(--color-hairline);
    background: rgb(255 255 255 / 0.04);
    padding: 0.6rem;
    font-size: 0.875rem;
    color: var(--color-muted);
  }
  .wide:hover {
    background: rgb(255 255 255 / 0.08);
    color: var(--color-ink);
  }
</style>
