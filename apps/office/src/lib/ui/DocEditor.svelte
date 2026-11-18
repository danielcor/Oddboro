<script lang="ts">
  import Markdown from './Markdown.svelte';

  // A document, rendered or in a text box, saved only by Save. FileEditor
  // feeds it a staffer's file; the Jobs tab feeds it a job description.
  type Props = {
    /** What is saved now. A new value replaces the draft. */
    text: string;
    /** For the text box's label. */
    name: string;
    markdown?: boolean;
    /** Whose words, so a path inside their folder links. */
    staff?: string;
    mode?: 'view' | 'edit';
    /** Sized to sit inside a panel rather than fill a window. */
    inline?: boolean;
    ondirty?: (dirty: boolean) => void;
    /** Saves the draft and returns what is saved now. Throws to say why not. */
    onsave: (draft: string) => Promise<string>;
  };
  let {
    text,
    name,
    markdown = true,
    staff,
    mode = $bindable('view'),
    inline = false,
    ondirty,
    onsave
  }: Props = $props();

  let saved = $state('');
  let draft = $state('');
  let busy = $state(false);
  let problem = $state('');
  $effect(() => {
    saved = text;
    draft = text;
  });

  const dirty = $derived(draft !== saved);
  $effect(() => ondirty?.(dirty));

  /** Open a proposed replacement for review. Keep any unsaved edit. */
  export function review(next: string): boolean {
    if (dirty || busy) return false;
    draft = next;
    mode = 'edit';
    return true;
  }

  export async function save(): Promise<boolean> {
    if (busy) return false;
    busy = true;
    problem = '';
    try {
      saved = await onsave(draft);
      draft = saved;
      return true;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
    }
  }

  function keys(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty) void save();
    }
  }
</script>

<div class="flex min-h-0 flex-col {inline ? '' : 'flex-1'}">
  <div class="flex min-h-0 flex-1 flex-col {inline ? '' : 'overflow-y-auto p-3'}">
    {#if problem}
      <p class="mb-3 rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
    {/if}
    {#if mode === 'view'}
      <div class={inline ? 'max-h-80 overflow-y-auto rounded-lg bg-night/60 px-3 py-2' : ''}>
        {#if markdown}
          <Markdown text={draft} {staff} class="text-sm" />
        {:else}
          <pre class="text-xs whitespace-pre-wrap">{draft}</pre>
        {/if}
      </div>
    {:else}
      <textarea
        class="min-h-0 resize-y rounded-lg px-3 py-2 font-mono text-xs leading-relaxed outline-none {inline
          ? 'bg-night/60'
          : 'flex-1 resize-none bg-raise'}"
        rows={inline ? 14 : undefined}
        aria-label={`Edit ${name}`}
        spellcheck="true"
        bind:value={draft}
        onkeydown={keys}></textarea>
    {/if}
  </div>

  <footer class="flex items-center gap-2 {inline ? 'pt-2' : 'border-t border-hairline p-3'}">
    <span class="flex-1 text-[11px] text-faint">
      {dirty ? 'Unsaved changes' : 'Saved'}
    </span>
    {#if dirty}
      <button
        class="rounded-lg px-3 py-1.5 text-xs text-muted hover:text-ink"
        onclick={() => (draft = saved)}>Undo changes</button
      >
    {/if}
    <button
      class="rounded-lg bg-sea px-3 py-1.5 text-xs font-medium text-night disabled:opacity-40"
      disabled={!dirty || busy}
      onclick={save}>{busy ? 'Saving' : 'Save'}</button
    >
  </footer>
</div>
