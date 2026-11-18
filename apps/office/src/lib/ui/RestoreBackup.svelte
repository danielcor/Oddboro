<script lang="ts">
  import { call, sendFile } from './api.ts';

  // Restore from a backup, in Settings and on a new office's first card. The
  // owner picks the file, says yes once, and the office checks the whole file,
  // saves itself aside, and starts again with the backup. A file that is not
  // a backup changes nothing and says why in one sentence. In the app the
  // shell opens the office again by itself; in a browser the page waits for
  // the office to answer again, then loads it.
  type Props = { label?: string };
  let { label = 'Restore from a backup' }: Props = $props();

  let picker = $state<HTMLInputElement>();
  let file = $state<File>();
  let stage = $state<'pick' | 'confirm' | 'sending' | 'restarting'>('pick');
  let slow = $state(false);
  let problem = $state('');

  function pick(e: Event & { currentTarget: HTMLInputElement }) {
    problem = '';
    file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file) stage = 'confirm';
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Health = { pid: number };

  async function restore() {
    if (!file) return;
    problem = '';
    stage = 'sending';
    try {
      const before = (await call<Health>('/api/health')).pid;
      await sendFile('/api/backup/restore', file, file.name, 'application/gzip');
      stage = 'restarting';
      await backAgain(before);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      stage = 'confirm';
    }
  }

  /** Ask once a second whether a new office answers, for up to five minutes, then load it. */
  async function backAgain(before: number) {
    for (let i = 0; i < 300; i++) {
      await wait(1000);
      if (i === 30) slow = true;
      const now = await call<Health>('/api/health').catch(() => undefined);
      if (now && now.pid !== before) return location.reload();
    }
  }
</script>

<div class="flex flex-col gap-2">
  <input bind:this={picker} type="file" accept=".oddboro" class="hidden" onchange={pick} />
  {#if stage === 'pick'}
    <button
      class="self-start rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20"
      onclick={() => picker?.click()}>{label}</button
    >
  {:else if stage === 'confirm' || stage === 'sending'}
    <div class="flex flex-col gap-2 rounded-lg bg-raise px-3 py-2 text-xs" role="group">
      <p class="font-medium text-ink">Restore {file?.name}?</p>
      <p class="text-muted">
        Your office as it is now is saved aside first, in the backups folder. Then the office starts
        again with the backup.
      </p>
      <div class="flex gap-2">
        <button
          class="rounded-lg bg-sea px-3 py-2 text-xs font-medium text-night disabled:opacity-40"
          disabled={stage === 'sending'}
          onclick={restore}>{stage === 'sending' ? 'Checking the file' : 'Restore'}</button
        >
        <button
          class="rounded-lg px-3 py-2 text-xs font-medium hover:bg-sea/20 disabled:opacity-40"
          disabled={stage === 'sending'}
          onclick={() => {
            stage = 'pick';
            problem = '';
          }}>Cancel</button
        >
      </div>
    </div>
  {:else}
    <p class="rounded-lg bg-sea/15 px-3 py-2 text-xs text-ink" role="status">
      Restoring. The office starts again by itself and opens with the backup.
      {#if slow}
        If you started the office from a terminal, start it again there to finish.
      {/if}
    </p>
  {/if}
  {#if problem}
    <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral" role="alert">{problem}</p>
  {/if}
</div>
