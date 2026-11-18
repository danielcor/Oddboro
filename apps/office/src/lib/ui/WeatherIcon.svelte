<script lang="ts">
  import type { Sky } from '#lib/weather.ts';

  // One icon per family of MET Norway symbols, in the panel's stroke style:
  // a 16 unit box, a 1.4 stroke in the text colour, round ends.
  let { sky, class: cls = 'size-4' }: { sky: Sky; class?: string } = $props();

  // A cloud whose base sits at y 12, moved up by `lift` for the skies that fall from it.
  const CLOUD = 'M4.6 12h6.9a2.6 2.6 0 0 0 .2-5.2 3.6 3.6 0 0 0-6.9-.6A2.9 2.9 0 0 0 4.6 12z';
  const SUN_RAYS =
    'M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9';
  const MOON = 'M12.6 10A5.2 5.2 0 0 1 6 3.4a5.2 5.2 0 1 0 6.6 6.6z';
</script>

<svg
  viewBox="0 0 16 16"
  class={cls}
  aria-hidden="true"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#if sky === 'clear-day'}
    <circle cx="8" cy="8" r="3" />
    <path d={SUN_RAYS} />
  {:else if sky === 'clear-night'}
    <path d={MOON} />
  {:else if sky === 'partly-day' || sky === 'partly-night'}
    {#if sky === 'partly-day'}
      <circle cx="5.5" cy="5.5" r="2" />
      <path d="M5.5 1.6v.8M1.6 5.5h.8M2.7 2.7l.6.6M8.3 2.7l-.6.6" />
    {:else}
      <path d="M8 5.6A3.4 3.4 0 0 1 3.9 1.5a3.4 3.4 0 1 0 4.1 4.1z" />
    {/if}
    <path d={CLOUD} transform="translate(1.2 1.6)" />
  {:else if sky === 'fog'}
    <path d="M2.5 5.5h11M1.5 8.5h10M4.5 11.5h10" />
  {:else}
    <path d={CLOUD} transform={sky === 'cloudy' ? 'translate(0 -0.5)' : 'translate(0 -3.5)'} />
    {#if sky === 'rain'}
      <path d="M5.5 11l-.8 2.5M8.5 11l-.8 2.5M11.5 11l-.8 2.5" />
    {:else if sky === 'sleet'}
      <path d="M6 11l-.8 2.5M10.5 11l-.8 2.5" />
      <circle cx="8" cy="13" r=".5" fill="currentColor" />
    {:else if sky === 'snow'}
      <circle cx="5" cy="11.5" r=".5" fill="currentColor" />
      <circle cx="8" cy="13" r=".5" fill="currentColor" />
      <circle cx="11" cy="11.5" r=".5" fill="currentColor" />
    {:else if sky === 'thunder'}
      <path d="M8.8 9.5L7 12.2h2.2l-1.6 2.6" />
    {/if}
  {/if}
</svg>
