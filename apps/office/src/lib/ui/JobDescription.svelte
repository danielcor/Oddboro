<script lang="ts">
  import DocEditor from './DocEditor.svelte';
  import AgentFileServers from './AgentFileServers.svelte';
  import { call } from './api.ts';
  import type { StaffProfile } from '../staff/roster.ts';
  import type { ImportedServer, SortedServers } from '../staff/claude-agent.ts';

  // The staffer's job description, the text every run starts from, in the
  // document editor. Folded until the owner opens it.
  type Props = { profile: StaffProfile; version: number };
  let { profile, version }: Props = $props();

  let shown = $state(false);
  let text = $state<string | undefined>();
  let mode = $state<'view' | 'edit'>('view');
  let dirty = $state(false);
  let problem = $state('');
  let editor: DocEditor | undefined = $state();
  let reading = $state(false);
  let fileMessage = $state('');
  /** The servers of the agent file under review, and which Save asks for (`sortFor`). */
  let fromFile = $state<{ servers: ImportedServer[]; sorted: SortedServers }>();
  // Saved or undone, the file's servers go with it.
  $effect(() => {
    if (!dirty) fromFile = undefined;
  });

  // Reload when the staffer changes it, unless the owner is mid-edit.
  $effect(() => {
    void version;
    if (!shown || dirty) return;
    let current = true;
    call<{ text: string }>(`/api/staff/${profile.id}/description`)
      .then((r) => {
        if (current) {
          text = r.text;
          problem = '';
        }
      })
      .catch((e: unknown) => {
        if (current) problem = e instanceof Error ? e.message : String(e);
      });
    return () => {
      current = false;
    };
  });

  async function reviewFile(file: File) {
    const opened = editor;
    if (!opened) return;
    reading = true;
    fileMessage = '';
    try {
      const { readClaudeAgentFile } = await import('../staff/claude-agent.ts');
      const agent = await readClaudeAgentFile(file);
      if (editor !== opened) return;
      if (agent.desk === text) {
        fileMessage = 'The saved instructions match this file.';
        return;
      }
      const sorted = agent.servers.length
        ? await call<SortedServers>(`/api/staff/${profile.id}/description`, {
            servers: agent.servers
          })
        : { asks: [], listed: [] };
      if (editor !== opened) return;
      if (opened.review(agent.desk)) fromFile = { servers: agent.servers, sorted };
      else fileMessage = 'Finish your current edit, then choose the file again.';
    } catch (e) {
      if (editor === opened) fileMessage = e instanceof Error ? e.message : String(e);
    } finally {
      reading = false;
    }
  }

  async function save(draft: string): Promise<string> {
    const r = await call<{ text: string }>(
      `/api/staff/${profile.id}/description`,
      { text: draft, was: text, servers: fromFile?.servers },
      'PUT'
    );
    text = r.text;
    return r.text;
  }
</script>

<section class="mb-3 rounded-xl bg-raise p-3" aria-label="Job description">
  <div class="flex items-center gap-2">
    <button
      class="flex-1 text-start text-sm font-medium"
      aria-expanded={shown}
      onclick={() => (shown = !shown)}>{shown ? '▾' : '▸'} Job description</button
    >
    {#if shown}
      <div
        class="flex gap-0.5 rounded-full bg-night/60 p-0.5"
        role="group"
        aria-label="View or edit"
      >
        {#each [{ id: 'view', label: 'View' }, { id: 'edit', label: 'Edit' }] as const as m (m.id)}
          <button
            class="rounded-full px-2.5 py-0.5 text-xs {mode === m.id
              ? 'bg-sea/30 text-ink'
              : 'text-muted'}"
            aria-pressed={mode === m.id}
            onclick={() => (mode = m.id)}>{m.label}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if shown}
    <p class="mt-1 text-[11px] text-faint">
      Who {profile.name} is and how it works. Every run starts from it, and you can also ask
      {profile.name} to change it in chat.
    </p>
    <div class="mt-2">
      {#if problem}
        <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
      {:else if text === undefined}
        <p class="py-4 text-center text-sm text-muted">Opening</p>
      {:else}
        {#if !profile.persona && !profile.manager}
          <label class="mb-2 block text-xs text-muted">
            Review job instructions from a Claude agent file
            <input
              type="file"
              accept=".md,.markdown"
              disabled={reading || dirty}
              onchange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) void reviewFile(file);
              }}
            />
          </label>
          {#if fileMessage}<p class="mb-2 text-xs text-muted" role="status">{fileMessage}</p>{/if}
          {#if fromFile && dirty}
            <div class="mb-2 flex flex-col gap-1 text-xs text-ink">
              <AgentFileServers
                sorted={fromFile.sorted}
                once="saved"
                note="Only the instructions change. Its tools and permission stay as they are."
              />
            </div>
          {/if}
        {/if}
        {#if dirty}
          <details class="mb-2 text-xs text-muted">
            <summary>Compare with saved instructions</summary>
            <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{text}</pre>
          </details>
        {/if}
        <DocEditor
          bind:this={editor}
          {text}
          name={`${profile.name}'s job description`}
          staff={profile.id}
          bind:mode
          inline
          ondirty={(d) => (dirty = d)}
          onsave={save}
        />
      {/if}
    </div>
  {/if}
</section>
