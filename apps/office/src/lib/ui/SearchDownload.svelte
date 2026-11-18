<script lang="ts">
  import type { Check } from '@oddboro/ledger/checks';
  import { call } from './api.ts';

  // Ledger search's Download button, on Setup's line for it in the welcome
  // and in the Setup window. Nothing downloads until the owner clicks it. The
  // office checks the model and answers with the line as it now stands.
  type Props = { check: Check; ondone: (check: Check) => void };
  let { check, ondone }: Props = $props();

  let busy = $state(false);
  let problem = $state('');
  async function download() {
    busy = true;
    problem = '';
    try {
      ondone(await call<Check>('/api/setup/search', {}));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<span class="flex flex-wrap items-center gap-2">
  <button class="btn" disabled={busy} onclick={download}
    >{busy ? 'Downloading…' : `Download (about ${check.download} MB)`}</button
  >
  <span class="text-faint">Finds entries by meaning, not only by their words.</span>
</span>
{#if problem}
  <span class="block text-coral" role="alert">{problem}</span>
{/if}
