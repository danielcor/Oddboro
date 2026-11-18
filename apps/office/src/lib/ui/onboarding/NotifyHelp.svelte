<script lang="ts">
  import type { System } from '@oddboro/ledger/platform';
  import { notifyHelp } from './notify-help.ts';

  // The steps when the owner did not see the test notification. Its own
  // component so a test can render it: MacCard reaches it only after it
  // fetches /api/setup, which a server render never does.
  type Props = {
    system: System | undefined;
    app: boolean;
    canOpen: boolean;
    onOpen: () => void;
    onTest: () => void;
  };
  let { system, app, canOpen, onOpen, onTest }: Props = $props();
  const steps = $derived(notifyHelp({ system, app, canOpen }));
</script>

<ol class="mt-2 list-decimal space-y-1 ps-4 text-xs text-muted">
  {#each steps as step (step.text)}
    <li>
      {#if step.test}
        <button class="link" onclick={onTest}>{step.text}</button>.
      {:else}
        {step.text}
        {#if step.open}
          <button class="link" onclick={onOpen}>Open it</button>
        {/if}
      {/if}
    </li>
  {/each}
</ol>
