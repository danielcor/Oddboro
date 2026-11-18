<script lang="ts">
  import { officeDay } from '@oddboro/ledger/time';
  import { call } from './api.ts';

  // The one line after a restore: which backup came back, and that each AI
  // tool needs its sign-in again, since a backup never holds one. Close
  // forgets it on the server, so it shows once.
  type Props = { restored: { madeAt: string } };
  let { restored }: Props = $props();
  let shown = $state(true);

  function close() {
    shown = false;
    void call('/api/backup', {}).catch(() => {});
  }
</script>

{#if shown}
  <div class="mt-2 flex items-start gap-2 rounded-lg bg-sea/15 px-3 py-2 text-xs" role="status">
    <p class="min-w-0 flex-1 text-ink">
      Your office is back from the backup made {officeDay(new Date(restored.madeAt))}. Sign in again
      to each AI tool your Odds use, on Setup's Your AI.
    </p>
    <button class="text-muted hover:text-ink" aria-label="Close" onclick={close}>✕</button>
  </div>
{/if}
