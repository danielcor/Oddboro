<script lang="ts">
  // Storage, under an Odd's Knowledge: everything it has kept in its own folder,
  // then under Shared work its part of each thread, one folder per piece of
  // work by its title. Each is a tree of folders that open and close, with
  // each file's size and when it changed. Search filters as the owner types,
  // and shows every match flat with its folder. A shared file reads as its
  // work's title and its path there, for search too, so a thread's number and
  // folder never show. A file opens in the office's viewer (`openFile`), as a
  // file an Odd names in chat does. The list is read when the tab opens, and
  // again when the office says something changed.
  import { call } from './api.ts';
  import { openFile } from './windows.svelte.ts';
  import {
    beforeName,
    countLine,
    matching,
    nameOf,
    nothingKept,
    ownRows,
    sharedRows,
    shownAs,
    treeOf,
    type Entry,
    type Row,
    type Tree,
    type Work
  } from './storage-list.ts';
  import type { Snippet } from 'svelte';
  import type { StaffProfile } from '../staff/roster.ts';

  type Props = { profile: StaffProfile; version: number };
  let { profile, version }: Props = $props();

  let entries = $state<Entry[]>([]);
  let work = $state<Work[]>([]);
  let capped = $state(false);
  let cap = $state(0);
  let loaded = $state(false);
  let problem = $state('');
  let find = $state('');
  /** Folders the owner opened, by path. */
  let open = $state<Record<string, boolean>>({});

  $effect(() => {
    void version;
    const id = profile.id;
    call<{ entries: Entry[]; work: Work[]; capped: boolean; cap: number }>(
      `/api/staff/${id}/storage`
    ).then(
      (r) => {
        entries = r.entries;
        work = r.work;
        capped = r.capped;
        cap = r.cap;
        loaded = true;
        problem = '';
      },
      (e) => {
        problem = e instanceof Error ? e.message : String(e);
        loaded = true;
      }
    );
  });

  const own = $derived(ownRows(entries));
  const shared = $derived(sharedRows(work));
  // Two trees, since an Odd's own folder can hold a path that reads like a shared one.
  const ownTree = $derived(treeOf(own));
  const sharedTree = $derived(treeOf(shared));
  const matches = $derived(matching(own, shared, find));

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  const when = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const show = (path: string) => openFile({ staff: profile.id, path });
</script>

{#snippet treeLabel(r: Row)}
  <span class="min-w-0 flex-1 truncate text-sm">{nameOf(r.path)}</span>
{/snippet}

<!-- A long title gives way first, then the folders, so the file's own name stays on the row. -->
{#snippet foundLabel(r: Row)}
  <span class="flex min-w-0 flex-1 text-sm">
    {#if r.work !== undefined}<span class="min-w-0 truncate">{r.work}</span>{/if}
    <span class="flex max-w-full shrink-0">
      <span class="min-w-0 truncate">{beforeName(r)}</span>
      <span class="max-w-full shrink-0 truncate">{nameOf(r.below)}</span>
    </span>
  </span>
{/snippet}

{#snippet fileRow(r: Row, depth: number, label: Snippet<[Row]>)}
  <li>
    <button
      class="flex w-full items-center gap-2 rounded-md py-1 pe-2 text-start hover:bg-night/40"
      style="padding-inline-start: {0.5 + depth * 0.9}rem"
      title={shownAs(r)}
      onclick={() => show(r.path)}
    >
      <svg
        class="size-3.5 shrink-0 text-muted"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        aria-hidden="true"><path d="M4 1.75h5l3 3v9.5H4zM9 1.75v3h3" /></svg
      >
      {@render label(r)}
      <span class="shrink-0 text-[10px] text-faint">{size(r.size)} · {when(r.mtime)}</span>
    </button>
  </li>
{/snippet}

{#snippet folderRow(tree: Tree, path: string, label: string, depth: number, tip?: string)}
  {@const isOpen = !!open[path]}
  <li>
    <button
      class="flex w-full items-center gap-2 rounded-md py-1 pe-2 text-start hover:bg-night/40"
      style="padding-inline-start: {0.5 + depth * 0.9}rem"
      title={tip}
      aria-expanded={isOpen}
      onclick={() => (open[path] = !isOpen)}
    >
      <span class="w-2.5 shrink-0 text-[10px] text-muted" aria-hidden="true"
        >{isOpen ? '▾' : '▸'}</span
      >
      <svg
        class="size-3.5 shrink-0 text-sea"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        aria-hidden="true"><path d="M1.75 4.25v8.5h12.5v-7h-6.5l-1.5-1.5h-4.5z" /></svg
      >
      <span class="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span class="shrink-0 text-[10px] text-faint">{(tree[path] ?? []).length}</span>
    </button>
  </li>
  {#if isOpen}
    {@render folder(tree, path, depth + 1)}
  {/if}
{/snippet}

{#snippet folder(tree: Tree, path: string, depth: number)}
  {#each tree[path] ?? [] as r (r.path)}
    {#if r.dir}
      {@render folderRow(tree, r.path, nameOf(r.path), depth)}
    {:else}
      {@render fileRow(r, depth + 1, treeLabel)}
    {/if}
  {/each}
{/snippet}

<section class="flex h-full min-h-0 flex-col p-3" aria-label="Storage">
  <input
    class="mb-2 w-full rounded-lg bg-raise px-2.5 py-1.5 text-sm outline-none placeholder:text-faint"
    type="search"
    aria-label="Find a file"
    placeholder="Find a file"
    autocomplete="off"
    spellcheck="false"
    bind:value={find}
  />
  <p class="mb-1.5 text-[11px] text-muted">
    {#if !loaded}
      Reading {profile.name}'s folder.
    {:else if capped}
      Showing the first {cap.toLocaleString()} entries.
    {:else}
      {countLine(own, `${profile.name}'s folder`)}
    {/if}
  </p>
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if problem}
      <p class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
    {:else if loaded && nothingKept(entries, work)}
      <p class="py-4 text-center text-sm text-muted">Nothing kept yet.</p>
    {:else if find.trim()}
      {#if matches.length}
        <ul>
          {#each matches as r (r)}
            {@render fileRow(r, 0, foundLabel)}
          {/each}
        </ul>
      {:else}
        <p class="py-4 text-center text-sm text-muted">No file matches "{find.trim()}".</p>
      {/if}
    {:else}
      <ul>{@render folder(ownTree, '', 0)}</ul>
      {#if work.length}
        <h3 class="mt-3 text-xs font-semibold text-ink">Shared work</h3>
        <p class="mb-1.5 text-[11px] text-muted">{countLine(shared, 'shared work')}</p>
        <ul>
          {#each work as w (w.root)}
            {@render folderRow(sharedTree, w.root, w.title, 0, w.title)}
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>
