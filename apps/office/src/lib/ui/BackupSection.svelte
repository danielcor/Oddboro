<script lang="ts">
  import RestoreBackup from './RestoreBackup.svelte';

  // The Setup window's Backup section: one click makes one file of the whole
  // office, less the sign-ins, and Restore puts one back. In a browser the
  // file downloads as any does. In the app the window opens the address in
  // the owner's browser, which saves it (apps/desktop, step 10). An office on
  // a database .env names backs that up with its own tools instead.
  type Props = { app: boolean; ownDatabase: boolean };
  let { app, ownDatabase }: Props = $props();
  let made = $state(false);
</script>

<section class="flex flex-col gap-2" aria-label="Backup">
  <h3 class="text-xs tracking-[0.16em] text-sea uppercase">Backup</h3>
  {#if ownDatabase}
    <a
      class="self-start rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
      href="/api/backup"
      download
      target={app ? '_blank' : undefined}
      rel="noreferrer"
      onclick={() => (made = true)}>Back up this office</a
    >
    <p class="text-xs text-muted">
      Keep this file somewhere private. It holds everything in your office except your sign-ins.
    </p>
    {#if made}
      <p class="text-xs text-faint" role="status">
        {app ? 'Your browser saves it' : 'It downloads'} as Oddboro backup with today's date, once the
        office has made it.
      </p>
    {/if}
    <RestoreBackup />
  {:else}
    <p class="text-xs text-muted">
      This office keeps its records in the database your .env names. Back that up with its own
      tools.
    </p>
  {/if}
</section>
