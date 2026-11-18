<script lang="ts">
  // The folders outside the office the owner gives an Odd, on the Folders tab
  // of its Access: a line on what read and write mean, then each folder in
  // path order, so one sits under any it is in, by its own name with where it
  // sits, its toggle and Remove, then Add a folder (Add another folder once
  // there is one), which opens the system's own picker
  // (`/api/folders/pick`) and says what it added. A path can be typed instead,
  // behind a link, or at once where no picker can open. A new folder starts at
  // Can read. A whole drive or system files comes back from the server as a
  // warning instead (`FolderWarning`), and goes in only on Accept. Each folder
  // has Can read and Can write side by side. Each shows with the home folder
  // written `~`, which only the server can work out, so the profile carries
  // it. A level change or Remove sends the path as stored, so a folder gone
  // from the disk can still go. A folder given before its secret store was
  // listed reaches no run, so it says why here and can still be removed; the
  // server works that out (`touchesStore`). Every other folder has Use in chat,
  // which opens the Odd's chat with the folder's path in the message box.
  import { FOLDER_LABEL, type FolderAccess } from '@oddboro/ledger/access';
  import { call } from './api.ts';
  import { chatAbout } from './chat-about.svelte.ts';
  import FolderWarning from './FolderWarning.svelte';
  import type { StaffProfile } from '../staff/roster.ts';

  type Props = {
    profile: StaffProfile;
    /** What the owner typed in the tab's search: only folders whose path has it show. */
    find?: string;
  };
  let { profile, find = '' }: Props = $props();
  /**
   * Paths in order part by part, so a folder sits right under any folder that
   * holds it: `~/site/app` follows `~/site`, ahead of `~/site-old`.
   */
  const byPath = (a: string, b: string): number => {
    const [x, y] = [a.split(/[\\/]/), b.split(/[\\/]/)];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = x[i].localeCompare(y[i]);
      if (c) return c;
    }
    return x.length - y.length;
  };
  const shown = $derived(
    profile.folders
      .filter((f) => f.shown.toLowerCase().includes(find.trim().toLowerCase()))
      .sort((a, b) => byPath(a.shown, b.shown))
  );

  /** The toggle's short words; each button's title carries the full level. */
  const SHORT: Record<FolderAccess, string> = { read: 'Can read', write: 'Can write' };
  const ACCESS: FolderAccess[] = ['read', 'write'];

  let typed = $state('');
  /** The typed path field: behind a link while a picker can open. */
  let typing = $state(false);
  let picking = $state(false);
  /** Why no picker opens here, once the server said so: the typed path shows instead. */
  let noPicker = $state('');
  /** The folder just added, so the owner sees it went in. */
  let added = $state('');
  /** The server's own line for a folder it refused, or a change that failed. */
  let problem = $state('');
  /** A folder the server warned about, waiting on Accept or Cancel. */
  let warned = $state<{ path: string; to: FolderAccess; warning: string }>();
  let accepting = $state(false);

  /** A folder's own name, the last part of its path. */
  const nameOf = (shown: string) =>
    shown
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || shown;
  /** Where it sits: the path without its own name. */
  const whereOf = (shown: string) =>
    shown.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || shown;

  /** Whether the change went in; a warning holds it for Accept or Cancel. */
  async function change(folder: string, to: FolderAccess | null, accept = false): Promise<boolean> {
    problem = '';
    added = '';
    warned = undefined;
    try {
      const r = await call<{ warning?: string }>(
        `/api/staff/${profile.id}`,
        { folder, access: to, accept },
        'PATCH'
      );
      if (r.warning && to) warned = { path: folder, to, warning: r.warning };
      return !r.warning;
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async function grant(path: string): Promise<boolean> {
    const ok = await change(path, 'read');
    if (ok) added = nameOf(path);
    return ok;
  }

  async function accept() {
    if (!warned) return;
    accepting = true;
    try {
      const { path, to } = warned;
      const fresh = !profile.folders.some((f) => f.path === path);
      if ((await change(path, to, true)) && fresh) {
        added = nameOf(path);
        typed = '';
        typing = false;
      }
    } finally {
      accepting = false;
    }
  }

  async function choose() {
    problem = '';
    added = '';
    picking = true;
    try {
      const r = await call<{ path?: string; cancelled?: true; unavailable?: string }>(
        '/api/folders/pick',
        { for: profile.name }
      );
      if (r.unavailable) noPicker = r.unavailable;
      else if (r.path) await grant(r.path);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      picking = false;
    }
  }

  async function add() {
    if (await grant(typed.trim())) {
      typed = '';
      typing = false;
    }
  }
</script>

<section aria-label="Folders" class="flex flex-col gap-2">
  <h3 class="text-xs font-semibold text-ink">Folders</h3>
  <p class="-mt-1 text-xs text-muted">
    Folders on this computer {profile.name} may open. Can read lets it read the files. Can write also
    lets it change them.
  </p>

  {#if profile.folders.length}
    <ul class="flex flex-col gap-1">
      {#each shown as f (f.path)}
        {@const now = (f.write ? 'write' : 'read') as FolderAccess}
        <li class="flex items-center gap-2 rounded-lg bg-raise px-2.5 py-2">
          <svg
            class="size-4 shrink-0 text-muted"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
            aria-hidden="true"><path d="M1.75 4.25v8.5h12.5v-7h-6.5l-1.5-1.5h-4.5z" /></svg
          >
          <span class="min-w-0 flex-1" title={f.shown}>
            <span class="block truncate text-sm font-medium">{nameOf(f.shown)}</span>
            <span class="block truncate text-[11px] text-muted">{whereOf(f.shown)}</span>
            {#if f.touchesStore}
              <span class="block text-[11px] text-ember"
                >Holds keys or sign-ins, so this Odd no longer gets it.</span
              >
            {:else}
              <button
                class="text-[11px] text-sea underline"
                aria-label={`Use in chat: ${nameOf(f.shown)}`}
                onclick={() =>
                  chatAbout(profile.id, `Use the relevant files in this folder.\n${f.path}\n\n`)}
                >Use in chat</button
              >
            {/if}
          </span>
          <span
            class="flex shrink-0 rounded-lg bg-night/60 p-0.5"
            role="radiogroup"
            aria-label="What {profile.name} may do in {nameOf(f.shown)}"
          >
            {#each ACCESS as a (a)}
              <button
                class="rounded-md px-2 py-0.5 text-xs whitespace-nowrap {now === a
                  ? 'bg-sea/25 text-ink'
                  : 'text-muted hover:text-ink'}"
                role="radio"
                aria-checked={now === a}
                title={FOLDER_LABEL[a]}
                onclick={() => now !== a && change(f.path, a)}>{SHORT[a]}</button
              >
            {/each}
          </span>
          <button
            class="shrink-0 rounded-full px-1.5 py-0.5 text-muted hover:text-coral"
            aria-label="Remove {nameOf(f.shown)}"
            title="Remove {nameOf(f.shown)}"
            onclick={() => change(f.path, null)}>✕</button
          >
        </li>
      {/each}
    </ul>
    {#if !shown.length}
      <p class="px-1 text-sm text-muted">No folder matches "{find.trim()}".</p>
    {/if}
  {:else}
    <p class="rounded-lg bg-raise px-3 py-3 text-sm text-muted">
      No folders yet. {profile.name} works only in its own folder until you add one.
    </p>
  {/if}

  {#if !noPicker}
    <button
      class="w-full rounded-lg border border-dashed border-hairline px-3 py-2 text-sm font-medium hover:border-sea hover:bg-sea/10 disabled:opacity-40"
      disabled={picking}
      onclick={choose}
      >{picking
        ? 'Pick it in the window that opened'
        : profile.folders.length
          ? '+ Add another folder'
          : '+ Add a folder'}</button
    >
  {:else}
    <p class="text-[11px] text-muted">{noPicker} Type its path instead.</p>
  {/if}

  {#if warned}
    <FolderWarning
      folder={warned.path}
      warning={warned.warning}
      busy={accepting}
      onaccept={accept}
      oncancel={() => (warned = undefined)}
    />
  {/if}

  {#if added}
    <p class="text-xs text-sea" role="status">Added {added}. It starts at Can read.</p>
  {/if}

  {#if typing || noPicker}
    <form
      class="flex gap-1.5"
      novalidate
      onsubmit={(e) => {
        e.preventDefault();
        if (typed.trim()) void add();
      }}
    >
      <input
        class="min-w-0 flex-1 rounded-lg bg-raise px-2 py-1 text-sm outline-none placeholder:text-faint"
        aria-label="A folder to give {profile.name}, by its path"
        placeholder="~/Documents/GitHub/my-game"
        autocomplete="off"
        spellcheck="false"
        bind:value={typed}
      />
      <button
        class="rounded-lg bg-raise px-2.5 py-1 text-xs font-medium hover:bg-sea/20 disabled:opacity-40"
        disabled={!typed.trim()}>Add</button
      >
    </form>
  {:else}
    <button
      class="self-start text-[11px] text-muted underline underline-offset-2 hover:text-ink"
      onclick={() => (typing = true)}>Type a path instead</button
    >
  {/if}

  {#if problem}
    <p class="text-[11px] text-coral">{problem}</p>
  {/if}
</section>
