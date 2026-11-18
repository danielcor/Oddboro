<script lang="ts">
  import {
    descriptionProblem,
    frontMatter,
    mentionsFiles,
    nameProblem,
    oneLine,
    skillProblem,
    skillSizeProblem
  } from '../staff/skill.ts';
  import { onMount } from 'svelte';
  import { call } from './api.ts';

  // Skills, under a local Odd's Knowledge: each skill the owner attached, by
  // name and when to use it, which every run lists, with Remove. Add a skill
  // reads a SKILL.md here, shows its text, and saves it once the owner says
  // when to use it. Read when the tab opens.
  type Skill = { name: string; description: string; text: string };
  type Draft = {
    name: string;
    description: string;
    text: string;
    asksForTools: boolean;
    mentionsFiles: boolean;
    /** The file had no description, so the owner writes one. */
    noDescription: boolean;
  };
  let { staff, name: odd }: { staff: string; name: string } = $props();
  let skills = $state<Skill[]>();
  let draft = $state<Draft | null>(null);
  let removing = $state<string | null>(null);
  let busy = $state(false);
  let problem = $state('');

  const saved = $derived(skills?.find((s) => draft && s.name === oneLine(draft.name)));
  const wrong = $derived(
    draft && (nameProblem(oneLine(draft.name)) ?? descriptionProblem(oneLine(draft.description)))
  );

  async function act(fn: () => Promise<void>) {
    busy = true;
    problem = '';
    try {
      await fn();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const load = () =>
    act(async () => {
      skills = (await call<{ skills: Skill[] }>(`/api/staff/${staff}/skills`)).skills;
    });

  onMount(() => void load());

  const choose = (input: HTMLInputElement) =>
    act(async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (file.name.toLowerCase() !== 'skill.md') throw new Error('Choose a file named SKILL.md.');
      const tooBig = skillSizeProblem(file.size);
      if (tooBig) throw new Error(tooBig);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const issue = skillProblem(text);
      if (issue) throw new Error(issue);
      const front = frontMatter(text);
      draft = {
        name: oneLine(front.name ?? ''),
        description: oneLine(front.description ?? ''),
        text,
        asksForTools: front.asksForTools,
        mentionsFiles: mentionsFiles(text),
        noDescription: !front.description
      };
    });

  /** Saves `skill` as `name`, or removes `name` when it is null, while `was` is still the saved copy. */
  const change = (name: string, was: Skill | undefined, skill: Draft | null) =>
    act(async () => {
      await call(
        `/api/staff/${staff}/skills`,
        {
          name,
          was: was ? { description: was.description, text: was.text } : null,
          skill: skill ? { description: oneLine(skill.description), text: skill.text } : null
        },
        'PUT'
      );
      draft = null;
      removing = null;
      skills = (await call<{ skills: Skill[] }>(`/api/staff/${staff}/skills`)).skills;
    });
</script>

<section class="h-full overflow-y-auto p-3" aria-label="Skills">
  <p class="text-[11px] text-faint">
    Instructions {odd} follows when a job calls for one. Every run lists each skill's name and when to
    use it, and {odd} reads the rest only when it needs it. A skill gives no tools, folders or permissions.
  </p>
  {#if problem}<p role="alert" class="mt-2 text-xs text-coral">{problem}</p>{/if}
  {#if skills}
    {#if skills.length}
      <ul class="mt-2 flex flex-col gap-1.5">
        {#each skills as skill (skill.name)}
          <li class="rounded-lg bg-raise px-3 py-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="flex-1 truncate font-medium text-ink">{skill.name}</span>
              {#if removing === skill.name}
                <button
                  class="text-coral"
                  disabled={busy}
                  onclick={() => change(skill.name, skill, null)}>Remove</button
                >
                <button disabled={busy} onclick={() => (removing = null)}>Keep</button>
              {:else}
                <button class="text-muted" disabled={busy} onclick={() => (removing = skill.name)}
                  >Remove</button
                >
              {/if}
            </div>
            <p class="mt-0.5 text-muted">{skill.description}</p>
          </li>
        {/each}
      </ul>
    {:else if !draft}
      <p class="mt-2 text-xs text-muted">No skills yet.</p>
    {/if}

    {#if draft}
      <div class="mt-3 flex flex-col gap-2 text-xs" aria-label="Add a skill">
        <label class="flex flex-col gap-1">
          <span class="text-muted">Name</span>
          <input
            class="rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint"
            placeholder="e.g. invoice-check"
            bind:value={draft.name}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-muted">When to use it</span>
          <textarea
            rows="2"
            class="resize-none rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint"
            placeholder="One line, e.g. Use when an invoice arrives."
            bind:value={draft.description}></textarea>
          {#if draft.noDescription}
            <span class="text-ember"
              >This SKILL.md does not say when to use it. Write one line, so {odd} knows when to read
              it.</span
            >
          {/if}
        </label>
        {#if draft.asksForTools}
          <p class="text-ember">
            This skill asks for tools. Odds get tools only from their Settings tab.
          </p>
        {/if}
        {#if draft.mentionsFiles}
          <p class="text-muted">
            This skill mentions other files. Only this SKILL.md is saved, so {odd} cannot use them.
          </p>
        {/if}
        {#if saved}
          <p class="text-muted">{odd} has a skill with this name. Saving replaces it.</p>
          <details>
            <summary class="text-muted">Saved copy</summary>
            <pre
              class="mt-1 max-h-48 overflow-auto rounded-lg bg-raise p-2 whitespace-pre-wrap">{saved.text}</pre>
          </details>
        {/if}
        <pre
          aria-label="Skill instructions"
          class="max-h-48 overflow-auto rounded-lg bg-raise p-2 whitespace-pre-wrap">{draft.text}</pre>
        <div class="flex items-center gap-2">
          <button
            disabled={busy || !!wrong}
            class="rounded-lg bg-sea px-3 py-1 font-medium text-night disabled:opacity-40"
            onclick={() => draft && change(oneLine(draft.name), saved, draft)}
            >{saved ? 'Save update' : 'Save skill'}</button
          >
          <button disabled={busy} onclick={() => (draft = null)}>Cancel</button>
          {#if wrong}<span class="text-faint">{wrong}</span>{/if}
        </div>
      </div>
    {:else}
      <label
        class="mt-2 inline-block cursor-pointer rounded-lg bg-raise px-3 py-1 text-xs font-medium text-sea"
      >
        Add a skill
        <input
          aria-label="Choose a SKILL.md"
          type="file"
          accept=".md"
          class="sr-only"
          disabled={busy}
          onchange={(event) => choose(event.currentTarget)}
        />
      </label>
    {/if}
  {/if}
</section>
