<script lang="ts">
  import { answerDiagnostics, diagnostics, shown } from './diagnostics.svelte.ts';

  // The Setup window's Diagnostics section: the one place the owner turns
  // error and trace reports on or off. With no answer the switch is off and
  // nothing is sent. Each flip keeps the answer at once; the office follows it
  // from the next report, with no restart. The switch appears only when reports
  // can go (`shown()`): to New Altitude, that means while signed in.
  let busy = $state(false);
  let problem = $state('');
  const on = $derived(diagnostics.answer === 'yes');

  async function flip() {
    busy = true;
    problem = '';
    try {
      await answerDiagnostics(on ? 'no' : 'yes');
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex flex-col gap-2" aria-label="Diagnostics">
  <h3 class="text-xs tracking-[0.16em] text-sea uppercase">Diagnostics</h3>
  <a
    class="self-start rounded-lg bg-raise px-3 py-2 text-xs text-ink"
    href="/api/diagnostics"
    target="_blank"
    rel="noopener">Save support report</a
  >
  <p class="text-xs text-muted">Save recent startup and update details to a file you can share.</p>
  {#if shown()}
    <button
      class="flex items-center gap-3 rounded-lg bg-raise px-3 py-2 text-start text-xs disabled:opacity-40"
      role="switch"
      aria-checked={on}
      aria-describedby="diagnostics-sent"
      disabled={busy}
      onclick={flip}
    >
      <span class="min-w-0 flex-1 text-ink">Send error and tracing reports to New Altitude</span>
      <span
        class="flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 {on
          ? 'justify-end bg-sea'
          : 'justify-start bg-night/60'}"
        aria-hidden="true"
      >
        <span class="size-4 rounded-full {on ? 'bg-night' : 'bg-muted'}"></span>
      </span>
    </button>
    <p id="diagnostics-sent" class="text-xs leading-relaxed text-muted">
      When something breaks, Oddboro can send New Altitude a report: what failed, where in the code,
      and how long it took.
      {#if diagnostics.account}
        Reports go with your New Altitude sign-in: New Altitude checks it, then passes the report on
        without it, so Sentry never learns your account.
      {/if}
      Never your chats, files, Odds' work, family details or name. Error text only in fixed forms, never
      your words. Sentry stores reports with your city and country, never your IP address.
      <a
        class="text-sea underline underline-offset-2"
        href="https://oddboro.com/privacy"
        target="_blank"
        rel="noreferrer">What is sent</a
      >
    </p>
  {/if}
  {#if problem}
    <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral" role="alert">{problem}</p>
  {/if}
</section>
