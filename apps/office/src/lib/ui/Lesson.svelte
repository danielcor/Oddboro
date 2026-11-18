<script lang="ts">
  // One lesson an Odd kept, in its chat where it kept it and on its Lessons
  // tab: Keep one that waits, Undo, reword it, say where it applies, or say
  // who it is for. A guess dropped unkept, or one undone, can still be kept
  // after all.
  import type { LessonLine, LessonUse } from '@oddboro/ledger';
  import { OPEN_LESSON } from '@oddboro/ledger/lesson-rules';
  import { call } from './api.ts';
  import { when } from './format.ts';

  /** On the Lessons tab, with the uses of the Odd whose tab it is. */
  type Shown = LessonLine & Partial<LessonUse>;
  type Props = {
    lesson: Shown;
    /** The Odd that heard it: a lesson is for that Odd or for every Odd. */
    name: string;
  };
  let { lesson, name }: Props = $props();

  /** The lesson as the owner's last change left it, until the next load brings it. */
  let changed = $state<Shown | undefined>();
  $effect(() => {
    void lesson;
    changed = undefined;
  });
  const l = $derived(changed ?? lesson);
  // A shown lesson can also read `dropped`, a state no stored row holds, so match by value.
  const open = $derived(OPEN_LESSON.some((s) => s === l.status));
  /** A lesson the Odd guessed, still waiting for the owner's Keep or dropped unkept. */
  const guess = $derived(l.status === 'waiting' || l.status === 'dropped');

  let editing = $state(false);
  let words = $state('');
  /** Where it applies, as the owner types it: empty is everywhere. */
  let where = $state('');
  let problem = $state('');

  async function change(patch: {
    text?: string;
    appliesTo?: string | null;
    scope?: 'me' | 'everyone';
    status?: string;
  }) {
    problem = '';
    try {
      // The change returns the lesson alone, so the uses shown stay as they were.
      changed = { ...l, ...(await call<LessonLine>(`/api/lessons/${l.id}`, patch, 'PATCH')) };
      editing = false;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Save sends only what the owner changed: new words become the lesson's
   * quote, so a change to where it applies alone keeps the quote it had.
   */
  function save() {
    const text = words.trim() === l.text ? undefined : words;
    const appliesTo = where.trim() === (l.appliesTo ?? '') ? undefined : where.trim() || null;
    if (text === undefined && appliesTo === undefined) editing = false;
    else change({ text, appliesTo });
  }
</script>

<div class="me-auto flex w-[85%] flex-col gap-1">
  <div class="-mb-0.5 ms-1 text-[10px] tracking-[0.16em] text-moss uppercase">
    {l.status === 'waiting' ? 'Lesson to keep?' : 'Lesson'} · {l.staffId
      ? `for ${name}`
      : 'for every Odd'}
  </div>
  <div class="rounded-2xl rounded-es-md border border-hairline px-3 py-2 text-sm text-ink">
    {#if editing}
      <textarea
        class="w-full resize-none rounded-lg bg-raise px-2 py-1.5 text-sm text-ink outline-none"
        rows="2"
        maxlength="240"
        aria-label="The lesson"
        bind:value={words}></textarea>
      <!-- The page cannot import lessons.ts, so 60 here is its APPLIES_TO_MAX. -->
      <input
        class="mt-1 w-full rounded-lg bg-raise px-2 py-1.5 text-xs text-ink outline-none placeholder:text-faint"
        maxlength="60"
        placeholder="Where it applies, like reports. Empty is everywhere."
        aria-label="Where it applies"
        bind:value={where}
      />
      <div class="mt-1 flex gap-3 text-xs">
        <button
          class="text-sea hover:text-ink disabled:opacity-40"
          disabled={!words.trim()}
          onclick={save}>Save</button
        >
        <button class="text-faint hover:text-ink" onclick={() => (editing = false)}>Cancel</button>
      </div>
    {:else}
      <p class="break-words" class:line-through={!open} class:text-muted={!open}>
        {guess ? 'I think you want me to remember: ' : "I'll remember: "}{l.text}
      </p>
      {#if l.appliesTo}
        <p class="mt-1 text-xs break-words text-muted">Only in: {l.appliesTo}</p>
      {/if}
      <p class="mt-1 text-xs break-words text-faint">From your words: “{l.quote}”</p>
      {#if l.missed}
        <p class="mt-1 text-xs text-coral">
          {l.missed === 1
            ? 'You had to tell me this again'
            : `You had to tell me this ${l.missed + 1} times`}
        </p>
      {/if}
      {#if l.uses !== undefined && l.status === 'live'}
        <p class="mt-1 text-xs text-faint">
          {l.uses
            ? `Changed the work ${l.uses === 1 ? 'once' : `${l.uses} times`}${l.lastUsedAt ? `, last ${when(l.lastUsedAt)}` : ''}`
            : 'Not used yet'}
        </p>
      {/if}
    {/if}
  </div>
  {#if !editing}
    <div class="ms-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {#if l.status === 'waiting'}
        <button class="text-sea hover:text-ink" onclick={() => change({ status: 'live' })}
          >Keep</button
        >
      {/if}
      {#if open}
        <button
          class="text-muted hover:text-ink"
          onclick={() => {
            words = l.text;
            where = l.appliesTo ?? '';
            editing = true;
          }}>Edit</button
        >
        <button
          class="text-muted hover:text-ink"
          onclick={() => change({ scope: l.staffId ? 'everyone' : 'me' })}
          >{l.staffId ? 'Make it for every Odd' : `Only for ${name}`}</button
        >
        <button class="text-faint hover:text-coral" onclick={() => change({ status: 'undone' })}
          >{l.status === 'waiting' ? 'No' : 'Undo'}</button
        >
      {:else if l.status === 'undone' || l.status === 'dropped'}
        <!-- The page cannot import lessons.ts, so 7 here is its GUESS_DAYS. -->
        <span class="text-faint"
          >{l.status === 'undone' ? 'Undone' : 'Dropped: not kept within 7 days'}</span
        >
        <button class="text-muted hover:text-ink" onclick={() => change({ status: 'live' })}
          >Keep after all</button
        >
      {:else}
        <span class="text-faint">Replaced by a newer lesson</span>
      {/if}
    </div>
  {/if}
  {#if problem}
    <p class="ms-1 text-xs text-coral">{problem}</p>
  {/if}
</div>
