<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { HireProposal, MissedRuns, Schedule } from '@oddboro/ledger';
  import { LEVEL_LABEL, LEVELS, type Level } from '@oddboro/ledger/access';
  import {
    AGENT_NAMES,
    EFFORT_NAMES,
    effortFor,
    hireToolsLine,
    MODELS,
    OFFICE_ACCOUNT,
    type Agent,
    type Effort
  } from '@oddboro/ledger/agents';
  import { HIRE_DEFAULTS } from '@oddboro/ledger/grantable';
  import { OFFICE_TOOLS } from '@oddboro/ledger/tools';
  import Pixel from './Pixel.svelte';
  import LookStudio, { type Drawn } from './LookStudio.svelte';
  import SchedulePicker from './SchedulePicker.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import { AgentTools } from './agent-tools.svelte.ts';
  import AccountSignIn from './AccountSignIn.svelte';
  import { account } from './account.svelte.ts';
  import PersonaBrief from './PersonaBrief.svelte';
  import AgentFileServers from './AgentFileServers.svelte';
  import PersonaOffer from './PersonaOffer.svelte';
  import { connect, PersonaOffers, personas as asked } from './persona-offers.svelte.ts';
  import {
    ordinaryFrom,
    personaNamed,
    proposalView,
    suggestedPersona,
    type Offer
  } from '#lib/persona.ts';
  import { call } from './api.ts';
  import { withActCheck } from './act-check.svelte.ts';
  import { wins } from './windows.svelte.ts';
  import type { StaffProfile } from '../staff/roster.ts';
  import type { ImportedServer, SortedServers } from '../staff/claude-agent.ts';

  type Props = {
    /** Rooms on the floor a staffer can work in: template id and name. */
    rooms: { id: string; name: string }[];
    /** A hire a staffer proposed. Hiring from it approves that ask. */
    from?: { askId: number; staff: string; proposal: HireProposal };
    /** The window this hire is open in. */
    id: string;
    onhired: (p: StaffProfile) => void;
    /** A persona hired here joined, through its own sign-in: the window closes. */
    ondone: () => void;
  };
  let { rooms, from, id, onhired, ondone }: Props = $props();

  // Hire opens on a choice: make an Odd, or hire a persona New Altitude offers
  // the owner's account. A proposal skips the choice: it opens on the builder,
  // or on the persona it names (`suggested`).
  // A window keeps the proposal it opened with, so its first value is the one.
  let path = $state<'choose' | 'odd' | 'persona'>(untrack(() => from) ? 'odd' : 'choose');
  // The offers, read once the account is signed in, so the list is ready when
  // the sign-in finishes.
  const personas = new PersonaOffers();
  const signedIn = $derived(account.status.state === 'in');
  /** The persona Hire was pressed for. The window closes once it joins. */
  let hiring = $state<string>();
  $effect(() => {
    const s = personas.state;
    if (
      hiring &&
      s?.state === 'ok' &&
      s.offers.some((o) => o.slug === hiring && o.joined === 'installed')
    )
      ondone();
  });

  function hirePersona(slug: string, askId?: number) {
    hiring = slug;
    void connect(slug, askId);
  }

  // A proposal that names a real person New Altitude offers as a persona shows
  // that persona in place of the builder, never a made-up look-alike. One that
  // says it means a persona New Altitude cannot show now asks for the sign-in,
  // or says why. The owner may always build an ordinary Odd instead, without
  // the person's likeness (`proposalView`, `ordinaryFrom`).
  let ordinary = $state(false);
  const view = $derived(ordinary ? 'odd' : proposalView(from?.proposal, personas.state));
  const suggested = $derived(
    view === 'persona' ? suggestedPersona(from?.proposal, personas.state) : undefined
  );
  /** The person a proposal that says it means a persona names, as it wrote them. */
  const person = $derived(from ? personaNamed(from.proposal) : '');
  /** How long a proposal's window waits for the offers before it opens the builder. */
  const OFFERS_WAIT_MS = 5000;
  // Until the offers answer, a proposal that may name a persona shows a
  // still placeholder, never the builder. If they have not answered in a few
  // seconds, the builder opens and stays.
  onMount(() => {
    if (view !== 'wait') return;
    const t = setTimeout(() => {
      if (!personas.state) buildOrdinary();
    }, OFFERS_WAIT_MS);
    return () => clearTimeout(t);
  });

  /**
   * Add the persona, as Setup's Add does, on the hire grid with it picked.
   * The office answers the proposal once the persona joins, even if this
   * window has closed by then.
   */
  function addSuggested(slug: string) {
    path = 'persona';
    hirePersona(slug, from?.askId);
  }

  /** The builder, with nothing of the person a proposal named (`ordinaryFrom`). */
  function buildOrdinary(o?: Offer) {
    const plain = ordinaryFrom(
      { name, role, appearance, personaSlug: from?.proposal.personaSlug },
      o
    );
    name = plain.name;
    role = plain.role;
    appearance = plain.appearance;
    ordinary = true;
  }

  const STEPS = ['Who', 'Where', 'Job description', 'Model', 'First job', 'Review'];
  let step = $state(0);
  let name = $state('');
  let role = $state('');
  /** The look the owner kept for them. Nobody is hired without one. */
  let look = $state<Drawn | undefined>();
  let appearance = $state('');
  let room = $state('');
  let brief = $state('');
  let remit = $state('');
  let desk = $state('');
  let permission = $state<Level>(HIRE_DEFAULTS.staff.permission);
  /**
   * What its runs go through, its hello first, picked as on an Odd's Model
   * tab: the tool (the office's own until the owner picks another), the
   * account it signs in with there, its model and how hard it thinks. Each is
   * the office's until picked, and all are stored with the hire.
   */
  const agentTools = new AgentTools();
  let pickedAgent = $state<Agent | undefined>();
  const agent = $derived(pickedAgent ?? agentTools.office);
  let pickedAccount = $state<string | null>(null);
  let pickedModel = $state<string | null>(null);
  let pickedEffort = $state<Effort | undefined>();
  /** The level its runs take: the one picked, made to fit the tool and model. */
  const effort = $derived(effortFor(agent, pickedEffort, false, pickedModel));
  const modelName = $derived(MODELS[agent].find((m) => m.id === pickedModel)?.name);
  const accountName = $derived(
    agentTools.accounts.find((a) => a.id === pickedAccount && a.agent === agent)?.label
  );

  /** Another tool: the account and model were that tool's, so both go back to the office's. */
  function pickAgent(a: Agent) {
    pickedAgent = a;
    pickedAccount = null;
    pickedModel = null;
  }
  /** Where the owner gives the hire tools later, by how its tool takes Run commands. */
  const toolsLine = $derived(
    hireToolsLine(agentTools.tools.find((t) => t.id === agent)?.commandsHow.state)
  );
  let jobName = $state('');
  let jobInstructions = $state('');
  /** Shown only once the owner names a job, so an empty job never reads as an hourly one. */
  let jobSchedule = $state<Schedule>({ every: 'minutes', n: 60 });
  /** Most first jobs make something for the owner to read, so this starts on. */
  let jobReport = $state(true);
  /** What the job does with runs it missed, as the proposal said. Changed later in its Jobs section. */
  let jobMissed = $state<MissedRuns | undefined>();
  /** Office tools from the proposal. Without one, a hire gets the starters. */
  let tools = $state<string[] | undefined>();
  let busy = $state(false);
  let problem = $state('');
  /**
   * What an imported Claude Code agent file brought: the settings it left in
   * the file, in plain words, and its MCP servers, sorted into the ones that
   * become access asks once hired and the ones only listed (`sortServers`).
   */
  let imported = $state<{ skipped: string; servers: ImportedServer[]; sorted: SortedServers }>();
  /** The hidden file box the Import button opens. */
  let picker = $state<HTMLInputElement>();

  async function importAgent(file: File) {
    busy = true;
    problem = '';
    try {
      const { readClaudeAgentFile, skippedSaid, sortServers } =
        await import('../staff/claude-agent.ts');
      const draft = await readClaudeAgentFile(file);
      // A server named only by a name asks when the office's tools have it.
      const known = draft.servers.some((s) => s.url === undefined && s.command === undefined)
        ? (await call<{ known: { id: string; name: string }[] }>('/api/connectors')).known
        : [];
      name = draft.name;
      role = draft.role;
      remit = draft.remit;
      desk = draft.desk;
      pickAgent('claude');
      pickedModel = draft.model;
      imported = {
        skipped: skippedSaid(draft.skipped),
        servers: draft.servers,
        sorted: sortServers(draft.servers, known)
      };
      step = 0;
      path = 'odd';
    } catch (e) {
      problem = e instanceof Error ? e.message : 'Could not read that agent file.';
    } finally {
      busy = false;
    }
  }

  /** Another choice drops what an imported file filled in, so it starts clean. */
  function choose(next: 'odd' | 'persona') {
    if (imported) {
      imported = undefined;
      name = role = remit = desk = '';
      pickedAgent = undefined;
      pickedAccount = null;
      pickedModel = null;
      step = 0;
    }
    problem = '';
    path = next;
  }

  // Fill the window from the proposal. The job description is read from its
  // file now, so edits the owner made in the viewer are in it.
  onMount(() => {
    if (!from) return;
    const p = from.proposal;
    name = p.name;
    role = p.role;
    remit = p.remit;
    permission = p.permission;
    room =
      rooms.find((r) => r.id === p.room || r.name.toLowerCase() === p.room?.toLowerCase())?.id ??
      '';
    tools = p.tools;
    appearance = p.appearance ?? '';
    if (p.job) {
      jobName = p.job.name;
      jobInstructions = p.job.instructions;
      jobSchedule = p.job.schedule;
      jobReport = p.job.report ?? true;
      jobMissed = p.job.missed;
    }
    busy = true;
    call<{ content: string }>(
      `/api/files?staff=${encodeURIComponent(from.staff)}&path=${encodeURIComponent(p.jobDescriptionFile)}`
    )
      .then((f) => (desk = f.content))
      .catch((e: unknown) => {
        problem = `Could not read the job description: ${e instanceof Error ? e.message : e}`;
      })
      .finally(() => (busy = false));
  });

  // The tab says who is being hired, and closing it asks first once there is
  // something to lose.
  $effect(() => {
    wins.titles[id] = name.trim() ? `Hire ${name.trim()}` : 'New hire';
    wins.dirty[id] = !!(name.trim() || desk.trim() || look);
  });

  /** A job goes with the hire only when it has a name. */
  const hasJob = $derived(!!jobName.trim());
  /** A hire with no job starts nothing alone: a goal's lead passes it each piece (`firstDay`). */
  const noJob = $derived(
    from?.proposal.goal
      ? "No job: its goal's lead passes it each piece of work"
      : 'No job: works only when a colleague passes it work'
  );

  const ready = $derived([
    !!name.trim() && !!role.trim() && !!look,
    !!room,
    !!remit.trim() && !!desk.trim(),
    true,
    !jobName.trim() === !jobInstructions.trim(),
    true
  ]);

  async function draftDesk() {
    busy = true;
    problem = '';
    try {
      const r = await call<{ desk: string }>('/api/staff/draft', {
        brief,
        name,
        role,
        permission,
        room: rooms.find((r) => r.id === room)?.name ?? ''
      });
      desk = r.desk;
      if (!remit.trim()) remit = brief.trim().slice(0, 200);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function hire() {
    busy = true;
    problem = '';
    const send = (actsOnHandOffs = false) =>
      call<StaffProfile>('/api/staff', {
        actsOnHandOffs,
        name,
        role,
        look: look?.look,
        portraitPx: look?.portraitPx,
        newParts: look?.newParts,
        room,
        permission,
        agent,
        account: pickedAccount,
        model: pickedModel,
        effort: pickedEffort ? effort : undefined,
        remit,
        desk,
        tools,
        servers: imported?.servers,
        askId: from?.askId,
        job: hasJob
          ? {
              name: jobName,
              instructions: jobInstructions,
              schedule: jobSchedule,
              report: jobReport,
              missed: jobMissed
            }
          : undefined
      });
    try {
      // A hire at Act waits for the owner's Act check, the first time only,
      // then for their choice for work another Odd hands it.
      const p = await (permission === 'act' ? withActCheck(name, send) : send());
      if (p) onhired(p);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const field = 'w-full rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint';
</script>

{#snippet choice(title: string, line: string, label: string, go: () => void)}
  <div class="flex flex-col gap-2 rounded-xl bg-raise p-3">
    <p class="font-semibold text-ink">{title}</p>
    <p class="text-xs leading-relaxed text-muted">{line}</p>
    <button
      class="self-start rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night"
      disabled={busy}
      onclick={go}>{label}</button
    >
  </div>
{/snippet}

{#if path === 'choose'}
  <section class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm" aria-label="Hire">
    {@render choice(
      'Hire an Odd',
      'Make a new worker: you pick its name, look, room and job.',
      'Hire an Odd',
      () => choose('odd')
    )}
    {@render choice(
      'Hire a persona',
      'Bring in a ready-made worker from New Altitude, with its own name, look and voice.',
      'Hire a persona',
      () => choose('persona')
    )}
    {@render choice(
      'Import a Claude Code agent',
      'Start from its Markdown file. You check its job and access before you hire it.',
      'Import',
      () => picker?.click()
    )}
    <input
      bind:this={picker}
      class="hidden"
      type="file"
      accept=".md"
      aria-label="Claude Code agent file"
      onchange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file) void importAgent(file);
      }}
    />
    {#if problem}<p class="text-xs text-coral" role="alert">{problem}</p>{/if}
  </section>
{:else if path === 'persona'}
  <section class="flex h-full min-h-0 flex-col" aria-label="Hire a persona">
    <header class="border-b border-hairline p-3">
      <div class="text-xs text-muted">
        Step {signedIn ? 2 : 1} of 2: {signedIn ? 'Pick a persona' : 'Sign in'}
      </div>
      <ol class="mt-2 flex gap-1" aria-hidden="true">
        <li class="h-1 flex-1 rounded-full bg-sea"></li>
        <li class="h-1 flex-1 rounded-full {signedIn ? 'bg-sea' : 'bg-raise'}"></li>
      </ol>
    </header>
    <div class="flex flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
      {#if !signedIn}
        <AccountSignIn
          ask={{
            question: 'Sign in to New Altitude',
            line: 'Personas come from your New Altitude account. Sign in to see the ones it offers you.'
          }}
        />
      {:else if personas.state?.state === 'ok'}
        {#if personas.state.offers.length === 0}
          <p class="leading-relaxed text-ink">New Altitude offers this account no personas yet.</p>
        {/if}
        <ul class="grid grid-cols-2 gap-3">
          {#each personas.state.offers as o (o.slug)}
            {@const mine = asked[o.slug]}
            <li
              class="flex flex-col items-center gap-2 rounded-xl bg-raise p-3 text-center {o.slug ===
              hiring
                ? 'ring-1 ring-sea'
                : ''}"
            >
              <img src={o.portrait} alt="" class="size-16 rounded-md [image-rendering:pixelated]" />
              <div>
                <p class="font-semibold text-ink">{o.displayName}</p>
                {#if o.jobTitle}<p class="text-muted">{o.jobTitle}</p>{/if}
              </div>
              <PersonaBrief offer={o} />
              {#if o.joined === 'installed'}
                <p class="mt-auto py-2 text-muted">Works here</p>
              {:else if mine?.waiting}
                <a
                  class="mt-auto py-2 text-sea underline underline-offset-2"
                  href={mine.waiting}
                  target="_blank"
                  rel="noopener">Finish on the sign-in page</a
                >
              {:else}
                <button
                  class="mt-auto w-full rounded-lg bg-sea px-3 py-2 font-medium text-night disabled:opacity-40"
                  disabled={mine?.busy}
                  onclick={() => hirePersona(o.slug)}>Hire {o.name}</button
                >
              {/if}
              {#if mine?.problem}
                <p class="rounded-lg bg-coral/15 px-2 py-1 text-coral" role="alert">
                  {mine.problem}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <!-- Signed in without the personas permission, refused, or not answering: its line and button. -->
        <PersonaOffer offers={personas} />
      {/if}
    </div>
    <footer class="flex gap-2 border-t border-hairline p-3">
      <button
        class="rounded-lg bg-raise px-3 py-2 text-sm"
        onclick={() => (path = from ? 'odd' : 'choose')}>Back</button
      >
    </footer>
  </section>
{:else if view === 'wait'}
  <section class="flex h-full min-h-0 flex-col gap-3 p-3" aria-label="Hire" aria-busy="true">
    <div class="h-28 rounded-xl bg-raise"></div>
  </section>
{:else if view === 'sign-in' || view === 'unreachable' || view === 'not-offered'}
  <section
    class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm"
    aria-label="Hire a persona"
  >
    <div class="flex flex-col gap-3 rounded-xl bg-raise p-3 text-xs">
      {#if personas.state?.state === 'out'}
        <!-- Signing in reads the offers again, so this turns into the persona or the line that it is not offered. -->
        <AccountSignIn
          ask={{
            question: `${person} is a New Altitude persona`,
            line: 'Sign in to New Altitude to add them.'
          }}
        />
      {:else if view === 'not-offered'}
        <p class="leading-relaxed text-ink">
          New Altitude does not offer {person} to your account.
        </p>
      {:else if view === 'unreachable'}
        <p class="leading-relaxed text-ink">
          {person} is a New Altitude persona, and New Altitude could not be reached.
        </p>
        <button
          class="self-start rounded-lg bg-sea px-3 py-2 font-medium text-night disabled:opacity-40"
          disabled={personas.busy}
          onclick={() => personas.load()}>Try again</button
        >
      {:else}
        <!-- Signed in without the personas permission, or refused: its line and button. -->
        <p class="leading-relaxed text-ink">{person} is a New Altitude persona.</p>
        <PersonaOffer offers={personas} />
      {/if}
    </div>
    <button
      class="rounded-lg bg-raise px-3 py-2 text-ink hover:bg-sea/20"
      onclick={() => buildOrdinary()}>Build an ordinary Odd instead</button
    >
    <p class="text-xs text-muted">An ordinary Odd gets a name and look of its own.</p>
  </section>
{:else if suggested}
  <section
    class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm"
    aria-label="Hire a persona"
  >
    <div class="flex gap-3 rounded-xl bg-raise p-3">
      <img
        src={suggested.portrait}
        alt=""
        class="size-16 shrink-0 rounded-md [image-rendering:pixelated]"
      />
      <div class="flex min-w-0 flex-col gap-2 text-xs">
        <div>
          <p class="text-sm font-semibold text-ink">{suggested.displayName}</p>
          {#if suggested.jobTitle}<p class="text-muted">{suggested.jobTitle}</p>{/if}
        </div>
        <p class="leading-relaxed text-ink">
          {suggested.displayName} is available as a New Altitude persona. Add the persona instead of building
          an Odd that looks like them.
        </p>
        <PersonaBrief offer={suggested} />
        <p class="leading-relaxed text-muted">{suggested.disclosure}</p>
      </div>
    </div>
    {#if suggested.joined === 'installed'}
      <p class="text-xs leading-relaxed text-ink">{suggested.name} already works in your office.</p>
    {:else}
      <button
        class="rounded-lg bg-sea px-3 py-2 font-medium text-night"
        onclick={() => addSuggested(suggested.slug)}>Add {suggested.name}</button
      >
    {/if}
    <button
      class="rounded-lg bg-raise px-3 py-2 text-ink hover:bg-sea/20"
      onclick={() => buildOrdinary(suggested)}>Build an ordinary Odd instead</button
    >
    <p class="text-xs text-muted">
      An ordinary Odd gets a name and look of its own, not {suggested.displayName}'s.
    </p>
  </section>
{:else}
  <section class="flex h-full min-h-0 flex-col" aria-label="Hire an Odd">
    {#if imported}
      <div class="flex flex-col gap-1 border-b border-hairline p-3 text-xs text-ink">
        <AgentFileServers
          sorted={imported.sorted}
          once="hired"
          note={imported.skipped && `Not brought over: ${imported.skipped}.`}
        />
      </div>
    {/if}
    <header class="border-b border-hairline p-3">
      <!-- No title: the window's tab already says Hire. -->
      <div class="text-xs text-muted">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}{from ? ' · from a proposal' : ''}
      </div>
      <ol class="mt-2 flex gap-1" aria-hidden="true">
        {#each STEPS as s, i (s)}
          <li class="h-1 flex-1 rounded-full {i <= step ? 'bg-sea' : 'bg-raise'}"></li>
        {/each}
      </ol>
    </header>

    {#if wins.confirm?.id === id}
      <div class="flex flex-wrap items-center gap-2 border-b border-hairline bg-ember/10 px-3 py-2">
        <span class="flex-1 text-xs text-ink"
          >{wins.busy[id] ? `Still drawing ${name || 'them'}.` : 'This hire is not finished.'} Close anyway?</span
        >
        <button
          class="rounded-lg bg-raise px-2.5 py-1 text-xs hover:bg-coral/25"
          onclick={() => wins.confirm?.go()}>Close it</button
        >
        <button
          class="rounded-lg px-2.5 py-1 text-xs text-muted hover:text-ink"
          onclick={() => (wins.confirm = undefined)}>Keep it open</button
        >
      </div>
    {/if}

    <div class="flex flex-1 flex-col gap-3 overflow-y-auto p-3 text-sm">
      {#if step === 0}
        <div class="grid grid-cols-2 gap-2">
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-xs text-muted">Name</span>
            <input class={field} placeholder="e.g. Mira" bind:value={name} />
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-xs text-muted">Role</span>
            <input class={field} placeholder="e.g. Mail Clerk" bind:value={role} />
          </label>
        </div>
        <LookStudio
          {name}
          {role}
          bind:description={appearance}
          kept={look}
          keepLabel="Keep this look"
          autoKeep
          onkeep={(d) => {
            look = d;
          }}
          onclear={() => (look = undefined)}
          onbusy={(b) => (wins.busy[id] = b)}
        />
      {:else if step === 1}
        <div class="text-xs text-muted">The room {name || 'they'} works in.</div>
        <div class="grid grid-cols-2 gap-2">
          {#each rooms as r (r.id)}
            <button
              class="rounded-xl px-3 py-2 text-start {room === r.id
                ? 'bg-sea/25 ring-1 ring-sea'
                : 'bg-raise'}"
              onclick={() => (room = r.id)}>{r.name}</button
            >
          {/each}
        </div>
      {:else if step === 2}
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">What is the job, in a sentence?</span>
          <textarea
            rows="2"
            class="{field} resize-none"
            placeholder="e.g. Sort my personal email and bring me anything that needs me"
            bind:value={brief}></textarea>
        </label>
        <button
          class="rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20 disabled:opacity-40"
          disabled={busy || !brief.trim()}
          onclick={draftDesk}>{busy ? 'Drafting' : 'Draft it'}</button
        >
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">One line for the card</span>
          <input class={field} placeholder="What this Odd is for" bind:value={remit} />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted">Job description (its instructions)</span>
          <textarea rows="10" class="{field} font-mono text-xs" bind:value={desk}></textarea>
        </label>
        <div>
          <div class="text-xs text-muted">Permission</div>
          <div class="mt-1 flex gap-1.5">
            {#each LEVELS as l (l)}
              <button
                class="flex-1 rounded-lg px-2 py-1.5 text-xs {permission === l
                  ? 'bg-sea/25'
                  : 'bg-raise'}"
                onclick={() => (permission = l)}>{LEVEL_LABEL[l]}</button
              >
            {/each}
          </div>
        </div>
      {:else if step === 3}
        <div class="flex flex-col gap-3">
          <ModelPicker
            tools={agentTools}
            name={name.trim() || 'this Odd'}
            {agent}
            account={pickedAccount}
            model={pickedModel}
            officeModel={agentTools.tools.find((t) => t.id === agent)?.officeModel}
            {effort}
            onagent={pickAgent}
            onaccount={(a) => {
              pickedAccount = a === OFFICE_ACCOUNT ? null : a;
            }}
            onmodel={(m) => (pickedModel = m)}
            oneffort={(e) => (pickedEffort = e)}
          />
        </div>
      {:else if step === 4}
        <p class="text-xs text-muted">{toolsLine}</p>
        <div class="flex flex-col gap-2 rounded-xl bg-raise p-3">
          <span class="text-xs text-muted">A first job</span>
          {#if !jobName.trim() && !jobInstructions.trim()}
            <span class="text-xs text-ink">{noJob}</span>
          {/if}
          <input
            class="{field} bg-night/60"
            placeholder="Name, e.g. Sort personal mail"
            bind:value={jobName}
          />
          <textarea
            rows="4"
            class="{field} resize-none bg-night/60"
            placeholder="What to do each run"
            bind:value={jobInstructions}></textarea>
          {#if hasJob}
            <SchedulePicker bind:value={jobSchedule} />
            <label class="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" bind:checked={jobReport} /> Put the result on my desk as a report
            </label>
          {/if}
        </div>
      {:else}
        <dl class="flex flex-col gap-2">
          <div>
            <dt class="text-xs text-muted">Who</dt>
            <dd>{name}, {role}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">Where</dt>
            <dd>{rooms.find((r) => r.id === room)?.name}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">For</dt>
            <dd>{remit}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">Permission</dt>
            <dd>{LEVEL_LABEL[permission]}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted">Runs on</dt>
            <dd>
              {[
                AGENT_NAMES[agent],
                modelName,
                accountName && `signed in as ${accountName}`,
                effort && `thinks ${EFFORT_NAMES[effort]}`
              ]
                .filter(Boolean)
                .join(', ')}
            </dd>
          </div>
          {#if tools}
            <div>
              <dt class="text-xs text-muted">Office tools</dt>
              <dd>
                {tools.map((t) => OFFICE_TOOLS.find((o) => o.id === t)?.name ?? t).join(', ') ||
                  'Only the ones every Odd has'}
              </dd>
            </div>
          {/if}
          <div>
            <dt class="text-xs text-muted">First job</dt>
            <dd>
              {hasJob ? `${jobName.trim()}${jobReport ? ', reports to your desk' : ''}` : noJob}
            </dd>
          </div>
        </dl>
        <div class="flex items-end justify-center gap-6 rounded-xl bg-raise p-3">
          {#if look}
            <Pixel src={look.portrait} scale={3} label={`${name}, portrait`} class="block" />
            <Pixel
              src={look.sheet}
              crop={{ x: look.frames['idle-down-0'] ?? 0, y: 0, w: 16, h: 32 }}
              scale={4}
              label={`${name}, standing`}
              class="block"
            />
          {/if}
        </div>
      {/if}
      {#if problem}
        <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
      {/if}
    </div>

    <footer class="flex gap-2 border-t border-hairline p-3">
      <!-- Back from the first step returns to the choice, except on a proposal. -->
      <button
        class="rounded-lg bg-raise px-3 py-2 text-sm disabled:opacity-40"
        disabled={(step === 0 && !!from) || busy}
        onclick={() => (step === 0 ? (path = 'choose') : step--)}>Back</button
      >
      {#if step < STEPS.length - 1}
        <button
          class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
          disabled={!ready[step] || busy}
          onclick={() => step++}>Next</button
        >
      {:else}
        <button
          class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
          disabled={busy}
          onclick={hire}>{busy ? 'Hiring' : `Hire ${name}`}</button
        >
      {/if}
    </footer>
  </section>
{/if}
