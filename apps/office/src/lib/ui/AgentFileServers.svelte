<script lang="ts">
  import type { SortedServers } from '../staff/claude-agent.ts';

  // What a Claude Code agent file brings beyond its instructions, in the hire
  // window and on an Odd's job description: the servers that become access
  // asks, and the ones only listed (`sortServers`).
  type Props = {
    sorted: SortedServers;
    /** When the asks are raised: "hired" or "saved". */
    once: string;
    /** A line first, about the file's other settings. */
    note?: string;
  };
  let { sorted, once, note }: Props = $props();
</script>

{#if note}<p>{note}</p>{/if}
{#if sorted.asks.length}
  <p>
    Asks you for access once {once}: {sorted.asks
      .map((a) => (a.name === a.label ? a.name : `${a.name} (${a.label})`))
      .join(', ')}. Nothing connects until you say yes.
  </p>
{/if}
{#if sorted.listed.length}
  <p class="text-muted">
    Listed only, never run: {sorted.listed.map((l) => `${l.name} (${l.why})`).join(', ')}.
  </p>
{/if}
