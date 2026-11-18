<script lang="ts" module>
  /** The rail's width, which the floor leaves free beside it. */
  export const ODDS_RAIL = 64;
  /** Its width while wide, with names and the search. */
  export const ODDS_RAIL_OPEN = 288;
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Pixel from './Pixel.svelte';
  import type { StaffProfile } from '../staff/roster.ts';
  import { railCount, railRing, tagWords, type ReaderProps } from '../staff/odd-now.ts';

  // Every Odd on a rail along the end edge of the screen: a ⌘K button on top,
  // then each Odd's portrait, with its count of work in progress or a ring
  // when it waits on the owner. Hovering the rail, moving into it with the
  // keyboard, or ⌘K widens the rail itself toward the floor: each portrait
  // gains its name and job title, and the top slot gains a search that
  // matches name, role or remit. From the search, the arrow keys pick an Odd
  // and Enter opens a chat with it. The portraits keep their place at the
  // edge, so nothing jumps. Off a Mac the shortcut is Ctrl+K, and the
  // button says so. The rail sits on the end side, so it flips in a
  // right-to-left page. The page slides it off the screen while an Odd's
  // panel is open.
  type Props = {
    staff: StaffProfile[];
    /** Each Odd's state, by id. */
    nowOf: ReaderProps['nowOf'];
    /** Each Odd on the floor, to the room it walks to, if any. One with no entry has not arrived. */
    headings: Record<string, string | undefined>;
    /** The Odd whose panel is open, marked on the rail. */
    selected?: string;
    /** Changes to widen the rail with the cursor in its search, as ⌘K does. */
    find?: number;
    /** Arrive wide, with the cursor in the search: ⌘K brought the rail back over an Odd's panel. */
    searching?: boolean;
    /** The rail narrowed with nothing picked: the page sends it away again if a card is open. */
    onleave?: () => void;
    /** The rail widened or narrowed, so a wide start panel can make room. */
    onwiden?: (open: boolean) => void;
    onselect: (id: string) => void;
    onchat: (id: string) => void;
  };
  let {
    staff,
    nowOf,
    headings,
    selected,
    find,
    searching = false,
    onleave,
    onwiden,
    onselect,
    onchat
  }: Props = $props();

  let hovering = $state(false);
  let focused = $state(false);
  /** Wide from ⌘K or the button, until the owner moves away from it. */
  let asked = $state(false);
  /** Narrow after a pick, until the pointer leaves the rail. */
  let picked = $state(false);
  let query = $state('');
  const open = $derived(!picked && (hovering || focused || asked || !!query.trim()));
  $effect(() => onwiden?.(open));
  /** The shortcut as this system names it. ⌘K until the page knows it is not on a Mac. */
  let mac = $state(true);
  const keyLabel = $derived(mac ? '⌘K' : 'Ctrl K');
  const keyName = $derived(mac ? 'Meta+K' : 'Control+K');

  let box: HTMLElement | undefined = $state();
  let search: HTMLInputElement | undefined = $state();
  /** The Odd the arrow keys are on, shown while the search has the cursor. */
  let active = $state(0);
  let typing = $state(false);

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!open || !q) return staff;
    return staff.filter((p) => [p.name, p.role, p.remit].some((s) => s.toLowerCase().includes(q)));
  });
  $effect(() => {
    void query;
    active = 0;
  });

  /** Widen the rail and put the cursor in its search. */
  function findOne() {
    picked = false;
    asked = true;
    void tick().then(() => {
      search?.focus();
      search?.select();
    });
  }

  // ⌘K pressed while the rail is here: only a change counts, so a rail that
  // comes back (Esc or ✕ closed the Odd's panel) arrives narrow, not wide
  // from the last ⌘K. Only `find` is read; the rest is untracked, so this
  // never runs itself again.
  let lastFind = untrack(() => find);
  $effect(() => {
    const f = find;
    if (!f || f === lastFind) return;
    lastFind = f;
    untrack(findOne);
  });
  onMount(() => {
    mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    if (searching) findOne();
  });

  function done() {
    picked = true;
    asked = false;
    focused = false;
    query = '';
    search?.blur();
  }

  function pick(id: string) {
    done();
    onselect(id);
  }

  function keys(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      query = '';
      asked = false;
      search?.blur();
      onleave?.();
    } else if (e.key === 'ArrowDown' && shown.length) active = (active + 1) % shown.length;
    else if (e.key === 'ArrowUp' && shown.length)
      active = (active - 1 + shown.length) % shown.length;
    else if (e.key === 'Enter' && shown[active]) {
      const id = shown[active].id;
      done();
      onchat(id);
    } else return;
    e.preventDefault();
  }

  const portrait = (p: StaffProfile) => ({
    src: p.look?.portrait,
    frame: `${p.portrait}/default`,
    fallback: `${p.sprite}@${p.variant}/idle-down-0`
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: hover only widens the rail; every action is a button. -->
<nav
  bind:this={box}
  class="rail glass pointer-events-auto absolute end-4 top-4 bottom-4 flex flex-col gap-1 overflow-hidden rounded-2xl py-2.5 max-sm:end-3 max-sm:top-3 max-sm:bottom-3"
  class:open
  style="--rail: {ODDS_RAIL}px; --rail-open: {ODDS_RAIL_OPEN}px"
  aria-label="Odds"
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => {
    hovering = false;
    picked = false;
    // A search with words in it, or the cursor in it, keeps the rail wide.
    if (!query.trim() && !typing) {
      asked = false;
      onleave?.();
    }
  }}
  onfocusin={() => {
    picked = false;
    focused = true;
  }}
  onfocusout={(e) => {
    if (!box?.contains(e.relatedTarget as Node | null)) focused = false;
  }}
>
  <!-- The same 12 px each side as a portrait's list and button, so the 40 px button sits
       centred on the narrow rail, in line with the portraits. -->
  <div class="row px-3">
    {#if open}
      <input
        bind:this={search}
        type="search"
        class="min-w-0 flex-1 rounded-lg bg-raise py-2 ps-3 text-sm outline-none placeholder:text-faint focus:ring-1 focus:ring-sea/60"
        placeholder={`Find one of ${staff.length}`}
        aria-label="Find an Odd by name, role or remit. Arrow keys pick one, Enter opens a chat."
        aria-keyshortcuts={keyName}
        bind:value={query}
        onkeydown={keys}
        onfocus={() => (typing = true)}
        onblur={() => (typing = false)}
      />
    {/if}
    <button
      class="grid size-10 shrink-0 place-items-center rounded-xl text-muted hover:bg-raise hover:text-ink"
      aria-label="Find an Odd"
      aria-keyshortcuts={keyName}
      title={`Find an Odd (${mac ? '⌘K' : 'Ctrl+K'})`}
      onclick={findOne}
    >
      <svg
        class="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg
      >
      <span class="-mt-1 text-[9px] leading-none text-faint" aria-hidden="true">{keyLabel}</span>
    </button>
  </div>
  <div class="mx-auto my-1 h-px w-8 shrink-0 bg-hairline" aria-hidden="true"></div>
  <p class="sr-only" aria-live="polite">
    {typing && shown[active] ? `${shown[active].name}, ${shown[active].role}` : ''}
  </p>
  <!-- Room on every side: a scrolling list clips the rings and counts drawn just outside each
       portrait. Narrow, the 40 px portrait, its 4 px of button and 8 px of list each side fill the
       64 px rail exactly. -->
  <ul class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-x-hidden overflow-y-auto px-2 py-1.5">
    {#each shown as p, i (p.id)}
      {@const now = nowOf(p.id)}
      {@const busy = now ? railCount(now) : 0}
      {@const on = selected === p.id}
      <li>
        <button
          class="row w-full rounded-xl p-1 text-start {on
            ? 'bg-sea/20'
            : 'hover:bg-raise'} {typing && i === active ? 'ring-1 ring-sea/70' : ''}"
          aria-label={`${p.name}, ${p.role}`}
          aria-current={on ? 'true' : undefined}
          title={`${p.name}, ${p.role}: ${now && p.id in headings ? tagWords(now, headings[p.id]) : 'Arriving'}`}
          onclick={() => pick(p.id)}
        >
          {#if open}
            <span class="min-w-0 flex-1 ps-2">
              <span class="block truncate text-sm font-medium text-ink">{p.name}</span>
              <span class="block truncate text-xs text-muted">{p.role}</span>
            </span>
          {/if}
          <span class="relative shrink-0">
            <Pixel
              {...portrait(p)}
              scale={1}
              label={p.name}
              class="flex size-10 items-center justify-center overflow-hidden rounded-lg bg-sea-deep {now &&
              railRing(now)
                ? 'ring-2 ring-ember'
                : ''}"
            />
            {#if busy}
              <span
                class="absolute -end-1 -bottom-1 grid min-w-4 place-items-center rounded-full bg-ember px-1 font-pixel text-[10px] leading-4 text-night"
                aria-hidden="true">{busy}</span
              >
            {/if}
          </span>
        </button>
      </li>
    {/each}
    {#if open && !shown.length}
      <li class="px-2 py-1 text-sm text-muted">No Odd matches "{query.trim()}".</li>
    {/if}
  </ul>
</nav>

<style>
  /* One rail that widens toward the floor; its portraits stay at the edge. */
  .rail {
    z-index: 20;
    inline-size: var(--rail);
    transition: inline-size 200ms ease;
  }
  .rail.open {
    inline-size: min(var(--rail-open), calc(100vw - 2rem));
  }
  @media (prefers-reduced-motion: reduce) {
    .rail {
      transition: none;
    }
  }
  /* A row puts the portrait at the edge, its words toward the floor. */
  .row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
