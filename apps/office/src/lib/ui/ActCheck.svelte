<script lang="ts">
  // The Act check, over the whole page (`showModal`, which keeps focus inside
  // it). Escape or Cancel closes it and nothing changes. The office checks the
  // answers (POST /api/act-check). Each statement is a card with a True and
  // False switch; after a check, a right one says so and a wrong one explains
  // why, and the answers stay for the owner to change and check again. A pass
  // shows for a moment, then the raise the owner was making goes ahead.
  import { onMount } from 'svelte';
  import { ACT_CHECK, ACT_CHECK_LEAD, ACT_CHECK_TITLE } from '@oddboro/ledger/act-check';
  import { actCheckClosed } from './act-check.svelte.ts';
  import { call } from './api.ts';

  /** How long the pass shows before the check closes. */
  const PASSED_MS = 1200;

  let dialog: HTMLDialogElement;
  let answers = $state<(boolean | undefined)[]>(ACT_CHECK.map(() => undefined));
  /** The statements the last check found wrong. */
  let wrong = $state<number[]>([]);
  /** True once a check has run, so a card can say right or wrong. */
  let checked = $state(false);
  let checking = $state(false);
  let passed = $state(false);
  let problem = $state('');
  const count = $derived(answers.filter((a) => a !== undefined).length);
  const answered = $derived(count === ACT_CHECK.length);

  /** The line beside the buttons: where the owner stands. */
  const status = $derived(
    checked && wrong.length
      ? `${ACT_CHECK.length - wrong.length} of ${ACT_CHECK.length} right. Change the ${
          wrong.length === 1 ? 'one' : 'ones'
        } marked and check again.`
      : `${count} of ${ACT_CHECK.length} answered`
  );

  onMount(() => dialog.showModal());

  async function check() {
    if (!answered || checking || passed) return;
    checking = true;
    problem = '';
    try {
      const r = await call<{ passed: boolean; wrong: number[] }>('/api/act-check', { answers });
      wrong = r.wrong;
      checked = true;
      if (r.passed) {
        passed = true;
        setTimeout(() => dialog.close(), PASSED_MS);
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
    }
  }

  function pick(i: number, value: boolean) {
    if (passed) return;
    answers[i] = value;
    wrong = wrong.filter((w) => w !== i);
  }

  /** A statement's card after a check: right, wrong, or not yet checked. */
  const stateOf = (i: number) =>
    !checked || answers[i] === undefined ? 'open' : wrong.includes(i) ? 'wrong' : 'right';
</script>

<!-- Keep the office's window shortcuts out of the check while it is open. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions: the dialog owns its keyboard events. -->
<dialog
  bind:this={dialog}
  aria-labelledby="act-check-title"
  aria-describedby="act-check-lead"
  class="m-auto max-h-[92dvh] w-[min(34rem,94vw)] overflow-y-auto rounded-2xl border border-hairline bg-panel-solid p-0 text-ink shadow-2xl backdrop:bg-night/75 backdrop:backdrop-blur-sm"
  onkeydown={(e) => e.stopPropagation()}
  onclose={() => actCheckClosed(passed)}
>
  <header class="border-b border-hairline px-6 pb-4 pt-5">
    <span
      class="inline-block rounded-full bg-ember/15 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ember"
      >Act level</span
    >
    <h2 id="act-check-title" class="mt-2 font-pixel text-2xl leading-tight">{ACT_CHECK_TITLE}</h2>
    <p id="act-check-lead" class="mt-1.5 text-sm text-muted">{ACT_CHECK_LEAD}</p>
  </header>

  {#if passed}
    <div class="px-6 py-10 text-center" role="status" aria-live="polite">
      <div
        class="mx-auto flex size-12 items-center justify-center rounded-full bg-moss/20 text-2xl text-moss"
        aria-hidden="true"
      >
        ✓
      </div>
      <p class="mt-3 font-medium">Passed</p>
      <p class="mt-1 text-sm text-muted">You won't see these questions again.</p>
    </div>
  {:else}
    <ol class="space-y-3 px-6 py-5">
      {#each ACT_CHECK as item, i (i)}
        {@const state = stateOf(i)}
        <li
          class="rounded-xl border p-4 transition-colors {state === 'wrong'
            ? 'border-coral/60 bg-coral/5'
            : state === 'right'
              ? 'border-moss/50 bg-moss/5'
              : 'border-hairline bg-raise/40'}"
        >
          <fieldset>
            <legend class="flex w-full items-start gap-3">
              <span
                class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold {state ===
                'wrong'
                  ? 'bg-coral/20 text-coral'
                  : state === 'right'
                    ? 'bg-moss/20 text-moss'
                    : 'bg-panel text-muted'}"
                aria-hidden="true">{state === 'right' ? '✓' : i + 1}</span
              >
              <span class="text-sm leading-relaxed">{item.says}</span>
            </legend>
            <div
              class="ms-9 mt-3 grid grid-cols-2 gap-1 rounded-lg border border-hairline bg-panel p-1"
              role="radiogroup"
              aria-label="Statement {i + 1}"
            >
              {#each [true, false] as value (value)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={answers[i] === value}
                  class="rounded-md px-3 py-1.5 text-sm transition-colors {answers[i] === value
                    ? 'bg-sea font-medium text-night'
                    : 'text-muted hover:bg-raise hover:text-ink'}"
                  disabled={checking}
                  onclick={() => pick(i, value)}>{value ? 'True' : 'False'}</button
                >
              {/each}
            </div>
            {#if state === 'wrong'}
              <p class="ms-9 mt-2.5 text-sm leading-relaxed text-ink" aria-live="polite">
                <span class="font-medium text-coral">Not quite.</span>
                {item.ifWrong}
              </p>
            {:else if state === 'right'}
              <p class="ms-9 mt-2 text-xs font-medium text-moss">Right</p>
            {/if}
          </fieldset>
        </li>
      {/each}
    </ol>

    {#if problem}<p class="px-6 pb-2 text-sm text-coral">{problem}</p>{/if}

    <footer
      class="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-6 py-4"
    >
      <p class="text-xs text-muted" aria-live="polite">{status}</p>
      <div class="ms-auto flex gap-2">
        <button
          type="button"
          class="rounded-lg px-4 py-2 text-sm text-muted hover:bg-raise hover:text-ink"
          disabled={checking}
          onclick={() => dialog.close()}>Cancel</button
        >
        <button
          type="button"
          class="rounded-lg px-4 py-2 text-sm font-medium transition-colors {answered
            ? 'bg-sea text-night hover:bg-sea-deep'
            : 'cursor-not-allowed bg-raise text-faint'}"
          disabled={!answered || checking}
          onclick={check}>{checking ? 'Checking…' : 'Check answers'}</button
        >
      </div>
    </footer>
  {/if}
</dialog>
