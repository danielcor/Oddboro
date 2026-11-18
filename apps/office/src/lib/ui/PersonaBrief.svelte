<script lang="ts">
  // What a persona is for, in its own pack's words: its remit, or its role when
  // the remit is empty. Shown only when that says more than the job title.
  import type { Offer } from '../persona.ts';

  let { offer }: { offer: Offer } = $props();
  const specialty = $derived(offer.remit.trim() || offer.role.trim());
</script>

{#if specialty && specialty !== offer.jobTitle}
  <details class="text-start text-xs leading-relaxed">
    <summary class="cursor-pointer font-medium text-sea">What can I ask {offer.name}?</summary>
    <p class="mt-2 whitespace-pre-line text-ink">{specialty}</p>
  </details>
{/if}
