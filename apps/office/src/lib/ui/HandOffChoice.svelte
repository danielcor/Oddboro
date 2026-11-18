<script lang="ts">
  // The owner's choice for work another Odd hands this Odd, asked each time
  // they put it at Act, right after the Act check (`withActCheck`). Over the
  // whole page like the check (`showModal`). Ask me first is picked to start
  // with. Escape or Cancel closes it and nothing changes; the primary button
  // closes it with the pick, and the raise sends both the level and the pick.
  import { onMount } from 'svelte';
  import { HAND_OFF_CHOICE, settingsTab } from '@oddboro/ledger/access';
  import { handOffChoiceClosed } from './act-check.svelte.ts';

  let { name }: { name: string } = $props();

  let dialog: HTMLDialogElement;
  let acts = $state(false);
  /** Set by the primary button, so closing the dialog any other way cancels. */
  let picked: boolean | undefined;

  const options = $derived([
    { value: false, label: HAND_OFF_CHOICE.ask.label, line: HAND_OFF_CHOICE.ask.line(name) },
    {
      value: true,
      label: HAND_OFF_CHOICE.acts.label(name),
      line: HAND_OFF_CHOICE.acts.line(name)
    }
  ]);

  onMount(() => dialog.showModal());

  function save() {
    picked = acts;
    dialog.close();
  }
</script>

<!-- Keep the office's window shortcuts out of the choice while it is open. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions: the dialog owns its keyboard events. -->
<dialog
  bind:this={dialog}
  aria-labelledby="hand-off-choice-title"
  class="m-auto max-h-[92dvh] w-[min(34rem,94vw)] overflow-y-auto rounded-2xl border border-hairline bg-panel-solid p-0 text-ink shadow-2xl backdrop:bg-night/75 backdrop:backdrop-blur-sm"
  onkeydown={(e) => e.stopPropagation()}
  onclose={() => handOffChoiceClosed(picked)}
>
  <header class="border-b border-hairline px-6 pb-4 pt-5">
    <span
      class="inline-block rounded-full bg-ember/15 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ember"
      >Act level</span
    >
    <h2 id="hand-off-choice-title" class="mt-2 font-pixel text-2xl leading-tight">
      {HAND_OFF_CHOICE.title(name)}
    </h2>
  </header>

  <div class="space-y-3 px-6 py-5" role="radiogroup" aria-labelledby="hand-off-choice-title">
    {#each options as o (o.value)}
      <button
        type="button"
        role="radio"
        aria-checked={acts === o.value}
        class="flex w-full items-start gap-3 rounded-xl border p-4 text-start transition-colors {acts ===
        o.value
          ? 'border-sea/60 bg-sea/10'
          : 'border-hairline bg-raise/40 hover:bg-raise'}"
        onclick={() => (acts = o.value)}
      >
        <span
          class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border {acts ===
          o.value
            ? 'border-sea bg-sea'
            : 'border-hairline bg-panel'}"
          aria-hidden="true"
        >
          {#if acts === o.value}<span class="size-2 rounded-full bg-night"></span>{/if}
        </span>
        <span class="min-w-0">
          <span class="block text-sm font-medium">{o.label}</span>
          <span class="mt-1 block text-sm leading-relaxed text-muted">{o.line}</span>
        </span>
      </button>
    {/each}
  </div>

  <footer
    class="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-6 py-4"
  >
    <p class="text-xs text-muted">You can change this later on {settingsTab(`${name}'s`)}.</p>
    <div class="ms-auto flex gap-2">
      <button
        type="button"
        class="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raise hover:text-ink"
        onclick={() => dialog.close()}>Cancel</button
      >
      <button
        type="button"
        class="rounded-lg bg-sea px-4 py-2 text-sm font-medium text-night transition-colors hover:bg-sea-deep"
        onclick={save}>Put {name} at Act</button
      >
    </div>
  </footer>
</dialog>
