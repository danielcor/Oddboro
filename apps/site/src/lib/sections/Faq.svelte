<script lang="ts">
  // Common questions as native disclosures. Each answer fades in once when
  // opened; the chevron turns. Code in an answer is marked in the text with
  // backticks and rendered as <code>.
  import SectionHeader from '#lib/components/SectionHeader.svelte';
  import { stagger } from '#lib/motion/index.ts';

  const faqs = [
    {
      q: 'What is an Odd?',
      a: 'An AI worker in your office. Each Odd runs on Claude Code, Codex or Grok, with one job description, a place on the floor, and the tools you connected for it.'
    },
    {
      q: 'What does it cost?',
      a: 'Oddboro itself is free under Apache 2.0. The AI your Odds run on costs what it already costs you, on your own plan or API key.'
    },
    {
      q: 'Which AI account do I need?',
      a: 'One of these: a Claude plan that signs in to Claude Code, or an Anthropic API key; the ChatGPT account you use with Codex; or your Grok account. You pick one for the office, and can run any Odd on another.'
    },
    {
      q: 'Can I hire my New Altitude personas?',
      a: 'Yes. Sign in to your New Altitude account from the office, and hire them as Odds. Their replies come from New Altitude.'
    },
    {
      q: 'Does it run on Windows or Linux?',
      a: 'Yes, both. Windows: an installer for Windows 10 and 11, on x64 and arm64. Linux: an AppImage for x86_64 and arm64, on a desktop with systemd, a keyring and notifications.'
    },
    {
      q: 'Will my Odds keep working when my laptop sleeps?',
      a: 'No. Odds work only while the computer running Oddboro is awake. When it wakes, missed jobs catch up or show on your Desk as skipped. To run jobs overnight, install Oddboro on a computer you can leave awake and keep the app running there. Its Odds need their own accounts and files there, and you check on them on that computer. The job schedule and work history stay on that computer.'
    },
    {
      q: 'What leaves my computer?',
      a: 'Only what the work needs. Odds send their work to the AI they run on, under your own account, and an Odd talks to the tools you connected for it. An Odd with Browse the web on sends its searches, and the pages it opens, to the web. The app checks GitHub for new versions of itself. Your sign-in goes to New Altitude only if you sign in to a New Altitude account, and error reports only if you are signed in and turn them on. A New Altitude persona you hire sends New Altitude what you ask it and what its work in your office found, which can include your files and data from your tools. New Altitude keeps it.'
    },
    {
      q: 'Can an Odd act without asking me?',
      a: 'Yes, within the limits you set. At the act level an Odd does housekeeping inside the office on its own, and uses any tool you gave it write access to. At draft, each change it wants to make in a tool waits on your desk for your yes, and so does everything else.'
    },
    {
      q: 'Can I pick the model?',
      a: 'Yes, for each Odd. Pick Claude Code, Codex or Grok, then a model from its list and how hard it thinks.'
    },
    {
      q: 'What is the Office Manager?',
      a: 'Your first Odd. It runs the floor, puts your daily report on your desk at 7 each morning, and helps you hire the rest. Pick one of the four ready-made managers, or describe your own.'
    },
    {
      q: 'How do I start over, or remove it?',
      a: 'On a Mac, turn off Open at login in the menu bar, quit Oddboro, and move it to the Trash. On Windows, turn off Open at login in the tray, quit Oddboro, and uninstall it in Settings, Apps. On Linux, turn off Open at login in the tray (or delete `~/.config/autostart/Oddboro.desktop`), quit Oddboro, and delete the AppImage. Every way, your office stays in the `.oddboro` folder in your home folder until you delete it. From source, `npm run reset` starts the office over: it moves the old one into `~/.oddboro/backups/` and deletes nothing. To remove a source install, run `npm run service:uninstall -w apps/office`, then delete the folder.'
    },
    {
      q: 'Who makes it?',
      a: 'New Altitude, Inc. The code is open, but the license grants no rights to the Oddboro name.'
    }
  ];

  /** Split an answer at its backticks: every second part is code. */
  const parts = (a: string) => a.split('`').map((text, i) => ({ text, code: i % 2 === 1 }));
</script>

<SectionHeader eyebrow="FAQ" title="Questions" align="center" />

<div use:stagger={{ step: 50 }} class="mx-auto mt-10 max-w-3xl">
  {#each faqs as f (f.q)}
    <details class="border-hairline group border-b">
      <summary
        class="text-ink hover:text-sea flex cursor-pointer list-none items-center justify-between gap-6 rounded-md py-5 text-lg font-semibold [&::-webkit-details-marker]:hidden"
      >
        {f.q}
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          class="faq-chevron text-faint shrink-0"
          aria-hidden="true"
        >
          <path
            d="M5 8l5 5 5-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </summary>
      <p class="faq-answer text-muted pb-6 text-[15px] leading-relaxed">
        {#each parts(f.a) as p, i (i)}
          {#if p.code}<code class="bg-raise text-ink rounded px-1.5 py-0.5 font-mono text-[13px]"
              >{p.text}</code
            >{:else}{p.text}{/if}
        {/each}
      </p>
    </details>
  {/each}
</div>
