<script lang="ts">
  import { tick } from 'svelte';
  import { clockTime } from '@oddboro/ledger/time';
  import { conditionWords, shownTemperature, skyOf } from '#lib/weather.ts';
  import { weather } from './weather.svelte.ts';
  import WeatherIcon from './WeatherIcon.svelte';

  // The weather beside the desk pill, the same size and shape: an icon and
  // the temperature. A click opens the place, the sky in words, when the
  // office last heard, and why a check failed, if one did: the last report
  // stays, with a quiet mark. Hidden while weather is off.
  let { onsetup }: { onsetup: () => void } = $props();

  let open = $state(false);
  let box = $state<HTMLElement>();

  const s = $derived(weather.setting);
  const r = $derived(weather.report);
  const sky = $derived(r ? skyOf(r.symbol) : undefined);
  const degrees = $derived(
    r?.temperature != null && s ? `${shownTemperature(r.temperature, s.unit)}°` : ''
  );
  const label = $derived(
    s && r
      ? `Weather in ${s.place}: ${conditionWords(r.symbol)}${degrees ? `, ${degrees}${s.unit}` : ''}`
      : 'Weather'
  );

  // Close on a click outside or Escape, listening only while open.
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box?.contains(e.target as Node)) open = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  });
</script>

{#if s && (r || weather.problem)}
  <div class="relative w-max" bind:this={box}>
    <button
      class="glass pointer-events-auto flex w-fit items-center gap-2 rounded-full px-4 py-2 text-sm"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onclick={() => (open = !open)}
    >
      {#if sky}
        <WeatherIcon {sky} class="size-5 {weather.problem ? 'text-muted' : 'text-ink'}" />
      {/if}
      <span class="tabular-nums {weather.problem ? 'text-muted' : 'text-ink'}"
        >{degrees || 'Weather'}</span
      >
      {#if weather.problem}
        <span class="size-1.5 rounded-full bg-coral/80" aria-hidden="true"></span>
      {/if}
    </button>
    {#if open}
      <div
        class="glass pointer-events-auto absolute start-1/2 top-full mt-2 w-max max-w-96 min-w-64 -translate-x-1/2 rounded-2xl p-3 text-xs rtl:translate-x-1/2"
        role="dialog"
        aria-label="Weather"
      >
        <div class="truncate font-medium text-ink" title={s.place}>{s.place}</div>
        {#if r && sky}
          <div class="mt-2 flex items-center gap-2 text-sm text-ink">
            <WeatherIcon {sky} class="size-5" />
            <span class="min-w-0 flex-1 truncate">{conditionWords(r.symbol)}</span>
            {#if degrees}<span class="tabular-nums">{degrees}{s.unit}</span>{/if}
          </div>
          <div class="mt-1 text-muted">Updated {clockTime(new Date(r.checkedAt))}</div>
        {/if}
        {#if weather.problem}
          <p class="mt-2 rounded-lg bg-coral/15 px-2 py-1.5 text-coral" role="status">
            The last check failed: {weather.problem}
            {r ? 'This is the last report.' : ''} The office tries again later.
          </p>
        {/if}
        <button
          class="mt-2 text-sea underline underline-offset-2"
          onclick={async () => {
            open = false;
            onsetup();
            await tick();
            document.getElementById('setup-weather')?.scrollIntoView({ block: 'nearest' });
          }}>Change in Setup</button
        >
        <p class="mt-2 border-t border-hairline pt-2 whitespace-nowrap text-faint">
          Weather from <a
            class="underline underline-offset-2 hover:text-muted"
            href="https://www.met.no/en"
            target="_blank"
            rel="noreferrer">MET Norway</a
          >. Places from
          <a
            class="underline underline-offset-2 hover:text-muted"
            href="https://www.geonames.org"
            target="_blank"
            rel="noreferrer">GeoNames</a
          >.
        </p>
      </div>
    {/if}
  </div>
{/if}
