<script lang="ts">
  import {
    disconnect,
    connect,
    OFFERS_LINE,
    personas,
    type PersonaOffers
  } from './persona-offers.svelte.ts';
  import PersonaBrief from './PersonaBrief.svelte';
  import PersonaQuiet, { opened } from './PersonaQuiet.svelte';

  // The New Altitude personas offered to this owner, each with what it is and
  // what it sends, and the one button for where it stands, in Setup's Account
  // section. A persona joins once its own sign-in finishes, and can be
  // disconnected. The hire window shows the offers as a grid of its own, and
  // this one only for its lines when New Altitude sent no list.
  type Props = { offers: PersonaOffers };
  let { offers }: Props = $props();

  const dataLine = (name: string) =>
    `${name}'s replies come from New Altitude. What you and your Odds send ${name}, and what ${name}'s hands find in your office, goes to New Altitude, which keeps it.`;

  const button =
    'rounded-lg bg-raise px-3 py-2 font-medium text-ink hover:bg-sea/20 disabled:opacity-40';
  const primary = 'rounded-lg bg-sea px-3 py-2 font-medium text-night disabled:opacity-40';
</script>

{#snippet problem(text: string | undefined)}
  {#if text}
    <p class="rounded-lg bg-coral/15 px-3 py-2 text-coral" role="alert">{text}</p>
  {/if}
{/snippet}

<div class="flex flex-col gap-3">
  {#if offers.signingIn}
    <div>{@render opened(offers.signingIn, () => (offers.signingIn = undefined))}</div>
  {/if}
  {#if offers.state && offers.state.state === 'ok'}
    {#each offers.state.offers as o (o.slug)}
      {@const mine = personas[o.slug]}
      <article class="flex gap-3 rounded-lg bg-raise/60 p-3">
        <img
          src={o.portrait}
          alt=""
          class="size-12 shrink-0 rounded-md [image-rendering:pixelated]"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <p class="font-semibold text-ink">{o.displayName}</p>
            {#if o.jobTitle}<p class="text-muted">{o.jobTitle}</p>{/if}
          </div>
          <PersonaBrief offer={o} />
          <p class="leading-relaxed text-ink">{o.disclosure}</p>
          <p class="leading-relaxed text-muted">{dataLine(o.name)}</p>
          {#if o.joined === 'installed' && o.quiet}
            <PersonaQuiet slug={o.slug} name={o.name} quiet={o.quiet} />
          {:else if mine?.waiting}
            <div>{@render opened(mine.waiting, () => (personas[o.slug] = {}))}</div>
          {:else if o.joined === 'installed'}
            <p class="leading-relaxed text-ink">{o.name} works in your office.</p>
            <button
              class="self-start {button}"
              disabled={mine?.busy}
              onclick={() => disconnect(o.slug)}>Disconnect</button
            >
            {@render problem(mine?.problem)}
          {:else}
            <!-- A granted persona joins at once, so one still here could not: the button tries again. -->
            <button
              class="self-start {primary}"
              disabled={mine?.busy}
              onclick={() => connect(o.slug)}>Add {o.name}</button
            >
            {@render problem(mine?.problem)}
          {/if}
        </div>
      </article>
    {/each}
  {:else if offers.state && offers.state.state !== 'out'}
    <p class="leading-relaxed text-ink">{OFFERS_LINE[offers.state.state]}</p>
    {#if offers.state.state === 'rescope'}
      <button
        class="self-start {primary}"
        disabled={offers.busy}
        onclick={() => offers.signInAgain()}>Sign in again</button
      >
    {:else}
      <button class="self-start {button}" disabled={offers.busy} onclick={() => offers.load()}
        >Try again</button
      >
    {/if}
  {/if}
  {@render problem(offers.problem)}
</div>
