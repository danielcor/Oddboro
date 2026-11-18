<script lang="ts">
  import {
    POSTAL_COUNTRIES,
    defaultUnit,
    isPostalCountry,
    type PlaceMatch,
    type Unit
  } from '#lib/weather.ts';
  import { setWeather, weather, weatherOff } from './weather.svelte.ts';

  // Setup's Weather section: off until the owner picks a country, types a
  // postal code and presses Show weather. The office looks the code up on this
  // computer and shows what it matched, so the owner can check it. The unit
  // follows the country until the owner picks one.
  const field = 'w-full rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint';

  const UNITS: Unit[] = ['C', 'F'];
  const lang = typeof navigator === 'undefined' ? 'en' : navigator.language;
  const names = new Intl.DisplayNames([lang], { type: 'region' });
  const countries = POSTAL_COUNTRIES.map((code) => ({ code, name: names.of(code) ?? code })).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const region = (() => {
    try {
      return new Intl.Locale(lang).maximize().region ?? '';
    } catch {
      return '';
    }
  })();

  const kept = weather.setting;
  const firstCountry = kept?.country ?? (isPostalCountry(region) ? region : '');
  let country = $state(firstCountry);
  let postal = $state(kept?.postal ?? '');
  let unit = $state<Unit>(kept?.unit ?? defaultUnit(firstCountry));
  let unitPicked = $state(!!kept);
  let busy = $state(false);
  let problem = $state('');
  let suggestion = $state<PlaceMatch>();
  // Setup can open before the page has heard the setting: fill the fields once it arrives.
  let filled = !!kept;
  $effect(() => {
    const s = weather.setting;
    if (!s || filled) return;
    filled = true;
    country = s.country;
    postal = s.postal;
    unit = s.unit;
    unitPicked = true;
  });

  const on = $derived(!!weather.setting);
  const changed = $derived(
    !weather.setting ||
      weather.setting.country !== country ||
      weather.setting.postal !== postal.trim()
  );

  async function show(code = postal) {
    postal = code;
    problem = '';
    suggestion = undefined;
    busy = true;
    try {
      const change = await setWeather(country, code.trim(), unit);
      if ('missing' in change) {
        problem = change.missing;
        suggestion = change.suggestion;
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function off() {
    problem = '';
    busy = true;
    try {
      await weatherOff();
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function pickUnit(u: Unit) {
    unit = u;
    unitPicked = true;
    // While weather is on, a new unit keeps at once. The code is not looked up again.
    if (on && !changed) void show();
  }
</script>

<section id="setup-weather" class="flex scroll-mt-3 flex-col gap-2" aria-label="Weather">
  <h3 class="text-xs tracking-[0.16em] text-sea uppercase">Weather</h3>
  <p class="text-xs text-muted">
    Show the weather where you are, beside your desk count at the top of the floor. Off until you
    turn it on.
  </p>
  <div class="flex gap-2">
    <label class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="text-xs text-muted">Country</span>
      <select
        class={field}
        bind:value={country}
        onchange={() => {
          if (!unitPicked) unit = defaultUnit(country);
        }}
      >
        {#if !country}<option value="" disabled>Pick your country</option>{/if}
        {#each countries as c (c.code)}
          <option value={c.code}>{c.name}</option>
        {/each}
      </select>
    </label>
    <label class="flex w-32 shrink-0 flex-col gap-1">
      <span class="text-xs text-muted">Postal code</span>
      <input
        class={field}
        placeholder="Your code"
        maxlength="12"
        autocomplete="postal-code"
        bind:value={postal}
        onkeydown={(e) => e.key === 'Enter' && country && postal.trim() && void show()}
      />
    </label>
  </div>
  <div class="flex items-center gap-2">
    <div
      class="flex rounded-lg bg-raise p-0.5 text-xs"
      role="radiogroup"
      aria-label="Temperature in"
    >
      {#each UNITS as u (u)}
        <button
          class="rounded-md px-2.5 py-1 {unit === u
            ? 'bg-sea/25 text-ink'
            : 'text-muted hover:text-ink'}"
          role="radio"
          aria-checked={unit === u}
          disabled={busy}
          onclick={() => pickUnit(u)}>°{u}</button
        >
      {/each}
    </div>
    <span class="flex-1"></span>
    {#if on}
      <button
        class="rounded-lg bg-raise px-3 py-2 text-xs font-medium hover:bg-sea/20 disabled:opacity-40"
        disabled={busy}
        onclick={off}>Turn off</button
      >
    {/if}
    {#if !on || changed}
      <button
        class="rounded-lg bg-sea px-3 py-2 text-xs font-medium text-night disabled:opacity-40"
        disabled={busy || !country || !postal.trim()}
        onclick={() => show()}>{busy ? 'Looking up' : 'Show weather'}</button
      >
    {/if}
  </div>
  {#if weather.setting && !problem}
    <p class="rounded-lg bg-raise px-3 py-2 text-xs text-ink" role="status">
      Matched: {weather.setting.place}
    </p>
  {/if}
  {#if problem}
    <div class="rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral" role="alert">
      <p>{problem}</p>
      {#if suggestion}
        <p class="mt-1">
          The closest is {suggestion.place}.
          <button class="underline underline-offset-2" onclick={() => show(suggestion!.code)}
            >Use {suggestion.code}</button
          >, or type a nearby code.
        </p>
      {:else if problem.startsWith('No place')}
        <p class="mt-1">Type a nearby code.</p>
      {/if}
    </div>
  {/if}
  <p class="text-xs leading-relaxed text-muted">
    Your country goes to GeoNames once to find your postal code on this computer. Rounded
    coordinates, about 11 km, go to MET Norway about once an hour while the office is open.
    <a
      class="text-sea underline underline-offset-2"
      href="https://oddboro.com/privacy"
      target="_blank"
      rel="noreferrer">What is sent</a
    >
  </p>
</section>
