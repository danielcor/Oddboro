<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AskRow, HandOffLine, PokeRow, ThreadLine } from '@oddboro/ledger';
  import { FIRST_QUESTIONS, firstQuestionIn } from '@oddboro/ledger/first-questions';
  import { clockTime } from '@oddboro/ledger/time';
  import ChatAccessAsk from './ChatAccessAsk.svelte';
  import ChatSignInCard from './ChatSignInCard.svelte';
  import Markdown from './Markdown.svelte';
  import TaskResponse from './TaskResponse.svelte';
  import { current, drafts, saved, type SavedResponse } from './task-response.svelte.ts';
  import { cardText } from './task-card.ts';
  import ChatGoal from './ChatGoal.svelte';
  import GoalProposal from './GoalProposal.svelte';
  import { approvalTarget, approveWord, yesWord } from './chat-approval.ts';
  import { chatAnswer } from './task-steps.ts';
  import BugReport from './BugReport.svelte';
  import { failedReply } from '../bug-report.ts';
  import UpdatesSection from './UpdatesSection.svelte';
  import Lesson from './Lesson.svelte';
  import PersonaQuiet from './PersonaQuiet.svelte';
  import { newTurnId } from '#lib/staff/chat-input.ts';
  import { call, sendFile, failure, type ApiUrl } from './api.ts';
  import ChatFiles from './ChatFiles.svelte';
  import { advanced, openProject } from './windows.svelte.ts';
  import { hideChoiceLines } from '#lib/choices.ts';
  import { hasToken, tagFor, withTokens, withoutToken, type Pending } from './chat-attach.ts';
  import {
    ACCEPT,
    attachableType,
    FILES_MAX,
    isPicture,
    refusal,
    type ChatFile
  } from '#lib/attachments.ts';
  import { when, workLine } from './format.ts';
  import { chatRequest, takeDraft, type Delivered } from './chat-about.svelte.ts';
  import type { StaffProfile } from '../staff/roster.ts';
  import { handOffProgress, workItems, type ReaderProps } from '../staff/odd-now.ts';
  import { runningFor, toolWords, type WorkAbout } from '../staff/work.ts';
  import type { ChatEntry, ChatEvent, ChatSignIn } from '../staff/chat.ts';
  import { counting, dayBreaks, fullDate, stamp, took } from './chat-lines.ts';
  import { serviceNames } from './service-names.svelte.ts';

  type Props = ReaderProps & {
    profile: StaffProfile;
    /** Bumps when the office changes, e.g. a poke lands or is set. */
    version: number;
    /** Fires when a message goes out, so the floor can send the staffer to the owner's office. */
    onstart: () => void;
    /** Fires when the reply is complete or fails. */
    onend: () => void;
    /** False while another tab covers the chat. It stays mounted either way. */
    visible: boolean;
    /** Opens something the staffer delivered, on the start side. */
    onitem: (item: Delivered) => void;
    /** Opens the info page at In progress. */
    onwork: () => void;
  };

  let {
    now,
    nowOf,
    profile,
    desk,
    staff,
    onplan,
    version,
    onstart,
    onend,
    visible,
    onitem,
    onwork
  }: Props = $props();
  /** Everything the Odd is working on now, shown at the foot of the chat. */
  const work = $derived(workItems(now));

  // A hidden list has no height to scroll, so catch up when it shows.
  $effect(() => {
    if (visible) scrollDown();
  });

  /** A chat line as the page keeps it: one sent or streaming has no time yet. */
  type Line = Omit<ChatEntry, 'at'> & { at?: string; pending?: boolean };

  /** A thread's steps in the order they happened: each hand-off given, and each run of the hub's own. */
  function threadSteps(
    t: NonNullable<Line['thread']>
  ): ({ at: string; h: HandOffLine } | { at: string; run: ThreadLine['runs'][number] })[] {
    return [
      ...t.steps.map((h) => ({ at: String(h.at), h })),
      ...t.line.runs.map((run) => ({ at: String(run.at), run }))
    ].sort((a, b) => a.at.localeCompare(b.at));
  }
  /** A block that only names what follows: headings, or a bold line on its own. */
  const label = (block: string) =>
    block.split('\n').every((l) => /^(#{1,6}\s.*|\*\*[^*]+\*\*:?)$/.test(l.trim()));
  /**
   * What the owner sees of a hand-off's text before opening it: its opening
   * paragraph, which the Odds' briefs ask them to write for the owner, with any
   * label above it. A lead still over `LONG` is cut and fades.
   */
  function lead(text: string): { text: string; more: boolean } {
    const blocks = text
      .replace(/\r\n?/g, '\n')
      .trim()
      .split(/\n\s*\n/);
    const i = blocks.findIndex((b) => !label(b));
    if (i < 0 || i === blocks.length - 1) return { text, more: false };
    return { text: blocks.slice(0, i + 1).join('\n\n'), more: true };
  }
  const LONG = 600;
  /** The hand-off stories and texts the owner opened. */
  const opened = new SvelteSet<string>();
  const toggle = (key: string) => opened.delete(key) || opened.add(key);

  const KIND: Record<Delivered['kind'], string> = {
    ask: 'Ask',
    task: 'Task for you',
    report: 'Report'
  };
  const STATUS: Record<string, string> = {
    open: 'Waiting on you',
    approved: 'Approved',
    denied: 'Denied',
    revise: 'Sent back',
    done: 'Done',
    dropped: 'Dropped',
    new: 'New',
    read: 'Read'
  };
  const keyOf = (d: Delivered) => `${d.kind}-${d.id}`;

  /** The delivery selected here, e.g. opened on the desk. */
  const selected = $derived(
    chatRequest.focus?.staff === profile.id ? keyOf(chatRequest.focus.item) : undefined
  );
  /** The delivery the next message replies about. */
  let replyTo = $state<Delivered | undefined>();

  let intent = $state<'reply' | 'proposal' | 'change'>('reply');
  let saving = $state(false);
  // Two plans can wait in the same chat. Each keeps its own checkboxes.
  let skipped = $state<Record<number, Record<number, boolean>>>({});
  const picks = (a: AskRow) => a.plan?.items.map((_, i) => i).filter((i) => !skipped[a.id]?.[i]);
  const proposal = (d: Delivered) =>
    d.kind === 'ask' &&
    desk.asks.find(
      (a) =>
        a.staffId === profile.id &&
        a.id === d.id &&
        ((a.kind === 'goal' && a.goal) || (a.kind === 'plan' && a.plan))
    );
  /**
   * An open task of this Odd's the owner answers here with one response, and
   * how (`chatAnswer`): a tap on its choice, or its response editor.
   */
  const question = (d: Delivered) => {
    if (d.kind !== 'task') return undefined;
    const t = desk.tasks.find((t) => t.staffId === profile.id && t.id === d.id);
    if (!t) return undefined;
    const files = desk.attachments.filter((f) => f.taskId === t.id);
    const how = chatAnswer({ ...t, response: current(t).response }, files.length > 0);
    return how && { ...how, why: t.why, task: t, files };
  };
  /** A finished task's saved response, read when the owner opens it on its card. */
  let unread = $state<Record<number, string>>({});
  async function readResponse(id: number) {
    if (saved[id]) return;
    try {
      saved[id] = await call<SavedResponse>(`/api/tasks/${id}`);
    } catch (err) {
      unread[id] = err instanceof Error ? err.message : String(err);
    }
  }

  let lines = $state<Line[]>([]);
  const waitingAsks = $derived(
    lines.flatMap(({ item }) => (item?.kind === 'ask' && item.status === 'open' ? [item] : []))
  );
  const onlyProposal = $derived(
    waitingAsks.length === 1 && proposal(waitingAsks[0]) ? waitingAsks[0] : undefined
  );
  // Remember what was on screen when the owner typed. A replacement arriving
  // before Send, a prefilled draft or a line replayed from history is no yes.
  let writtenDecision = $state('');
  let approveTo = $state<Delivered>();
  function typed(text: string) {
    const words = text.trim();
    if (!approveWord(writtenDecision) && approveWord(words)) approveTo = onlyProposal;
    if (!approveWord(words)) approveTo = undefined;
    writtenDecision = approveWord(words) || yesWord(words) ? words : '';
  }

  function pick(d: Delivered) {
    chatRequest.focus = { staff: profile.id, item: d };
    onitem(d);
  }
  async function reply(d: Delivered, how: typeof intent = 'reply') {
    if (saving) return;
    refused = '';
    intent = how === 'reply' && proposal(d) ? 'proposal' : how;
    chatRequest.focus = { staff: profile.id, item: d };
    replyTo = d;
    await tick();
    box?.focus();
  }

  // Reply on the desk or a report window arrives here once the chat shows.
  $effect(() => {
    const r = chatRequest.reply;
    if (r?.staff !== profile.id || !visible) return;
    chatRequest.reply = undefined;
    void reply(r.item);
  });

  // Bring the selected delivery into view once the history is in.
  $effect(() => {
    if (!selected || !loaded || !visible) return;
    void tick().then(() =>
      list
        ?.querySelector(`[data-item="${selected}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    );
  });
  let draft = $state('');
  /** What the bug report form starts with, while it is open. */
  let bugReport = $state<{ title?: string; body: string }>();
  // One live section per chat, even when the owner asked about updates before.
  const latestUpdate = $derived(lines.findLast((line) => line.updates));
  let sending = $state(false);
  // The office already holds the text, files and reply target under this turn id.
  type Blocked = { turnId: string; signIn: ChatSignIn };
  let blocked = $state<Blocked>();
  const signInKey = () => `oddboro-chat-sign-in-${profile.id}`;
  onMount(() => {
    try {
      const value = sessionStorage.getItem(signInKey());
      if (value) blocked = JSON.parse(value);
    } catch {
      /* The open chat still holds the request when storage is unavailable. */
    }
  });
  function hold(value?: Blocked) {
    blocked = value;
    try {
      if (value) sessionStorage.setItem(signInKey(), JSON.stringify(value));
      else sessionStorage.removeItem(signInKey());
    } catch {
      /* Storage is optional in the desktop window. */
    }
  }
  function continueChat(turnId: string) {
    const request = blocked?.signIn;
    if (blocked?.turnId !== turnId || !request || sending || remoteBusy) return;
    hold();
    if (profile.agent === request.agent && (profile.account ?? 'office') === request.account) {
      const line = lines.find((l) => l.from === 'owner' && l.turnId === turnId);
      if (line) void say(line.text, line.re, line.files ?? [], line);
    }
  }
  let remoteBusy = $state(false);
  let active = $state<{ runId: string; turnId: string }>();
  let stopping = $state(false);
  let adding = $state(false);
  let about = $state<WorkAbout>();
  let newest = 0;

  async function stop() {
    if (!active || stopping) return;
    const selected = active.runId;
    stopping = true;
    try {
      await call(`/api/staff/${profile.id}/chat`, { runId: selected }, 'DELETE');
      if (active?.runId === selected) active = undefined;
      if (!sending) load(profile.id);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    } finally {
      stopping = false;
    }
  }

  function direct(target: WorkAbout) {
    chatRequest.work = target;
    chatRequest.staff = target.leadId;
  }

  $effect(() => {
    if (!visible || chatRequest.work?.leadId !== profile.id) return;
    typed('');
    intent = 'reply';
    about = chatRequest.work;
    chatRequest.work = undefined;
    void tick().then(() => box?.focus());
  });
  /**
   * What the owner sent while a reply was still coming: it goes once that
   * reply ends. A second Send while one waits joins it, so the Odd answers
   * both in one turn.
   */
  type Waiting = { text: string; re?: Delivered; files: ChatFile[]; about?: WorkAbout };
  let waiting = $state<Waiting | undefined>();
  /**
   * Send now adds a waiting message to the reply that is running, in the same
   * turn. Only Claude Code reads more words while it works; Codex, Grok and
   * Gemini read their message once, and a persona hears only the first. A
   * message about a desk item or a job goes as its own message, with its brief.
   */
  const addsToReply = $derived(profile.agent === 'claude' && !profile.persona);
  const offersNow = (w: Waiting) => addsToReply && !!active && !w.re && !w.about;

  /** Add the waiting message to the running reply; one the reply can no longer take stays queued. */
  async function sendNow() {
    const next = waiting;
    const reply = active;
    if (!next || !reply || adding || next.files.length || !offersNow(next)) return;
    adding = true;
    waiting = undefined;
    try {
      const { added } = await call<{ added: boolean }>(
        `/api/staff/${profile.id}/chat`,
        { runId: reply.runId, message: next.text },
        'PATCH'
      );
      if (!added) throw new Error();
      const line: Line = {
        from: 'owner',
        text: next.text,
        turnId: reply.turnId,
        source: { kind: 'added' },
        at: new Date().toISOString()
      };
      // Above the reply it joins, when this window shows that reply.
      const at = lines.findLastIndex((l) => l.pending && l.turnId === reply.turnId);
      lines.splice(at < 0 ? lines.length : at, 0, line);
      scrollDown();
    } catch (err) {
      // Too late for this reply: it goes as the next message, with anything the box queued since.
      const since = waiting as Waiting | undefined;
      waiting = since
        ? { ...since, text: [next.text, since.text].filter(Boolean).join('\n\n') }
        : next;
      if (err instanceof Error && err.message) refused = err.message;
    } finally {
      adding = false;
    }
  }
  let status = $state('');
  let loaded = $state(false);
  let list: HTMLDivElement | undefined = $state();

  async function scrollDown() {
    await tick();
    list?.scrollTo({ top: list.scrollHeight });
  }

  // Reading the newest message stays reading it when the list gets shorter:
  // the input growing as the owner types, the panel resizing.
  function pin(node: HTMLDivElement) {
    let atBottom = true;
    const scrolled = () => (atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 8);
    const resized = new ResizeObserver(() => {
      if (atBottom) node.scrollTop = node.scrollHeight;
    });
    node.addEventListener('scroll', scrolled);
    resized.observe(node);
    return () => {
      node.removeEventListener('scroll', scrolled);
      resized.disconnect();
    };
  }

  /**
   * The clock the chat's times read. It moves when the page re-renders
   * anyway, and once a minute only while a stamp still counts minutes or a
   * run is going, so a still chat redraws nothing.
   */
  let clock = $state(Date.now());
  const ticking = $derived(
    work.some((w) => !w.queued) || lines.some((l) => l.at && counting(l.at, new Date(clock)))
  );
  $effect(() => {
    if (!visible || !ticking) return;
    const timer = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    void work;
    void lines.length;
    void visible;
    clock = Date.now();
  });
  /** The day break above each line, if any. */
  const breaks = $derived(
    dayBreaks(
      lines.map((l) => l.at),
      new Date(clock)
    )
  );

  /** Whether Open on Desk has somewhere to go: an ask or task still waiting there, or any report. */
  const opens = (d: Delivered) =>
    d.kind === 'report' || (d.kind === 'ask' ? desk.asks : desk.tasks).some((r) => r.id === d.id);

  /** A card's words for Copy: its title, and why, steps and response while the desk holds them. */
  function cardCopy(d: Delivered): string {
    const a = d.kind === 'ask' ? desk.asks.find((r) => r.id === d.id) : undefined;
    const t = d.kind === 'task' ? desk.tasks.find((r) => r.id === d.id) : undefined;
    return cardText({
      kind: KIND[d.kind],
      title: d.title,
      why: (a ?? t)?.why,
      steps: t?.steps,
      response:
        d.kind === 'task'
          ? (drafts[d.id]?.text ?? (t ? current(t).response : saved[d.id]?.response))
          : undefined
    });
  }

  /** The line whose text was just copied, which says so for a moment. */
  let copied = $state<number | undefined>();
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(i: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    copied = i;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = undefined), 1500);
  }

  /** Pokes the staffer set that have not landed yet. */
  let upcoming = $state<PokeRow[]>([]);

  function load(id: string) {
    fetch(`/api/staff/${id}/chat` satisfies ApiUrl)
      .then((r) => r.json())
      .then(
        (d: { history: ChatEntry[]; busy: boolean; reply?: { runId: string; turnId: string } }) => {
          // A message that started meanwhile is streaming into the list: keep it.
          if (sending) return;
          remoteBusy = d.busy;
          active = d.reply;
          lines = d.history.map((h) => ({ ...h }));
          loaded = true;
          scrollDown();
        }
      )
      .catch(() => (loaded = true));
    call<PokeRow[]>(`/api/staff/${id}/pokes`)
      .then((p) => (upcoming = p))
      .catch(() => {});
  }

  $effect(() => {
    loaded = false;
    load(profile.id);
  });
  // A poke landing or being set changes the office: catch up, unless a reply
  // is streaming into the list right now.
  let seen = 0;
  $effect(() => {
    if (version === seen) return;
    seen = version;
    if (!sending) load(profile.id);
  });

  // The chat on screen means its pokes are read; the page then lets the staffer go.
  // Also when one lands while the chat is open: it shows, so it is read.
  $effect(() => {
    void lines.length;
    if (visible && loaded) void call(`/api/staff/${profile.id}/pokes`, {}).catch(() => {});
  });

  async function pokeNow(p: PokeRow) {
    await call(`/api/pokes/${p.id}`, {}).catch(() => {});
    upcoming = upcoming.filter((x) => x.id !== p.id);
  }

  async function cancel(p: PokeRow) {
    await call(`/api/pokes/${p.id}`, undefined, 'DELETE').catch(() => {});
    upcoming = upcoming.filter((x) => x.id !== p.id);
  }

  /**
   * The Desk's own operations. Only a card the owner picked can supply the
   * target. Each says it came from this chat, so the Odd's reply comes back here.
   */
  async function decide(d: Delivered, act: 'approve' | 'change' | 'choose', words = '') {
    if (saving || !decisionMode) return false;
    saving = true;
    refused = '';
    try {
      if (act === 'choose') {
        const how = question(d);
        if (!how?.choice) throw new Error('This task is no longer waiting for this answer.');
        // A tap answers the choice as the Desk does, then finishes the task.
        await call(`/api/tasks/${d.id}`, {
          op: 'choose',
          index: how.choice.index,
          answer: words
        });
        await call(`/api/tasks/${d.id}`, { op: 'finish', done: true, chat: true });
      } else {
        const a = proposal(d);
        if (!a) throw new Error('This proposal is no longer open.');
        if (act === 'change' && words.length > 2000)
          throw new Error('Keep the changes to 2,000 characters.');
        const result = await call<{ hires?: AskRow[] }>(`/api/asks/${a.id}`, {
          decision: act === 'change' ? 'iterate' : 'approve',
          reason: words,
          picks: picks(a),
          chat: true
        });
        if (result.hires?.length) onplan(result.hires);
      }
      return true;
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      saving = false;
      load(profile.id);
    }
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    await submit(false);
  }

  /** Send the box, or queue it while a reply runs; `now` also adds it to that reply (Ctrl+Enter). */
  async function submit(now: boolean) {
    if (saving || uploading) return;
    const words = draft.trim();
    if (!words && !pending.length) return;
    if (decisionMode) {
      const re = replyTo;
      const explicit = approveWord(words);
      const approved = approvalTarget(
        words,
        writtenDecision,
        intent === 'proposal' ? re : undefined,
        approveTo,
        re ? undefined : onlyProposal
      );
      const action = intent === 'change' ? intent : approved ? 'approve' : undefined;
      const target = re ?? approved;
      if (target && action) {
        if (!(await decide(target, action, action === 'approve' ? '' : words))) return;
        draft = '';
        writtenDecision = '';
        approveTo = undefined;
        replyTo = undefined;
        intent = 'reply';
        return;
      }
      if (explicit && (re?.kind === 'ask' || (!re && (approveTo || waitingAsks.length)))) {
        refused = re
          ? 'Open this ask to see the action it needs.'
          : 'Choose Reply under the proposal you want to approve.';
        return;
      }
      writtenDecision = '';
      approveTo = undefined;
    }
    typed('');
    intent = 'reply';
    const message = draft;
    const target = about;
    if ((!message.trim() && !pending.length) || uploading) return;
    let files: ChatFile[] = [];
    if (pending.length) {
      // Each file goes to the Odd's attachments folder first; the message names them.
      uploading = true;
      try {
        files = await toAttachments(pending);
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
        return;
      } finally {
        uploading = false;
      }
    }
    const re = replyTo;
    draft = '';
    replyTo = undefined;
    clearTray();
    about = undefined;
    if (sending || remoteBusy) {
      waiting = waiting
        ? {
            text: [waiting.text, message].filter(Boolean).join('\n\n'),
            re: waiting.re ?? re,
            files: [...waiting.files, ...files],
            about: waiting.about ?? target
          }
        : { text: message, re, files, about: target };
      scrollDown();
      if (now) await sendNow();
      return;
    }
    await say(message, re, files, undefined, { about: target });
  }

  // A saved queue also waits for a reply started in another office window.
  $effect(() => {
    if (sending || remoteBusy || !waiting) return;
    const next = waiting;
    waiting = undefined;
    void say(next.text, next.re, next.files, undefined, { about: next.about });
  });

  /**
   * Retry under the owner's message while no reply answered its turn, a stopped
   * one included, even after later messages. Not while that turn's reply still
   * runs: a reopened card has no line of it yet, and learns it runs only from
   * its load (`active`). Not under words added to a turn: Retry on the turn's
   * first message sends them too.
   */
  function retryable(line: Line, i: number): boolean {
    if (sending || line.from !== 'owner' || !line.turnId || line.source?.kind === 'added')
      return false;
    if (active?.turnId === line.turnId) return false;
    const answered = (l: Line) =>
      l.from === 'staff' && !l.failed && !l.pending && l.turnId === line.turnId;
    return !lines.slice(i + 1).some(answered);
  }

  /** Take back the message waiting to go: it returns to the box. */
  function unwait() {
    if (!waiting) return;
    draft = [waiting.text, draft.trim() && draft].filter(Boolean).join('\n\n');
    replyTo ??= waiting.re;
    about ??= waiting.about;
    // Its files go back in the tray, already kept in the Odd's attachments folder.
    const text = draft;
    pending = [
      ...waiting.files.map((f) => ({
        key: nextKey++,
        tag: f.tag,
        mediaType: f.mediaType,
        size: f.size,
        kept: f,
        url: isPicture(f.mediaType) ? attachmentUrl(f) : undefined,
        inline: hasToken(text, f.tag)
      })),
      ...pending
    ];
    waiting = undefined;
    void tick().then(() => {
      fit();
      box?.focus();
    });
  }

  /**
   * The answers to tap under the manager's first questions (`FIRST_QUESTIONS`):
   * only while the question is the chat's last line. Typing an answer works too.
   */
  const answers = $derived.by((): { list: readonly string[]; first: boolean } => {
    const last = lines.at(-1);
    if (
      saving ||
      remoteBusy ||
      sending ||
      !last ||
      last.from !== 'staff' ||
      last.pending ||
      last.failed
    )
      return { list: [], first: false };
    // Choices the Odd ended its reply with (`splitChoices`), else the manager's first questions.
    if (last.choices?.length) return { list: last.choices, first: false };
    return { list: FIRST_QUESTIONS[firstQuestionIn(last.text)]?.answers ?? [], first: true };
  });

  /** Send one message and stream the reply into the chat. */
  async function say(
    message: string,
    re?: Delivered,
    files: ChatFile[] = [],
    retry?: Line,
    context: { about?: WorkAbout } = {}
  ) {
    const generation = ++newest;
    const turnId = retry?.turnId ?? newTurnId();
    sending = true;
    status = 'Thinking';
    if (!retry)
      lines.push({
        from: 'owner',
        turnId,
        source: { kind: 'chat' },
        about: context.about,
        // Files alone are a message too: their tags say it, as the server writes it.
        text: message || files.map((f) => `[${f.tag}]`).join(' '),
        re,
        at: new Date().toISOString(),
        ...(files.length ? { files } : {})
      });
    lines.push({ from: 'staff', text: '', pending: true, turnId });
    const reply = lines[lines.length - 1];
    scrollDown();
    onstart();
    try {
      const res = await fetch(`/api/staff/${profile.id}/chat` satisfies ApiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          retry?.inputHash
            ? { turnId }
            : {
                turnId,
                message,
                about: context.about?.key ?? retry?.about?.key,
                re: re && { kind: re.kind, id: re.id },
                ...(files.length ? { files: files.map(({ tag, name }) => ({ tag, name })) } : {})
              }
        )
      });
      if (!res.ok || !res.body) throw await failure(res);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!chunk.startsWith('data: ')) continue;
          const ev = JSON.parse(chunk.slice(6)) as ChatEvent;
          if (generation !== newest) {
            if (ev.type === 'done' || ev.type === 'error') {
              reply.text = ev.type === 'done' ? ev.text : ev.message;
              reply.pending = false;
              reply.failed = ev.type === 'error' ? true : undefined;
            }
            continue;
          }
          if (ev.type === 'reply') active = ev;
          else if (ev.type === 'delta') {
            reply.text += ev.text;
            status = '';
          } else if (ev.type === 'tool') status = toolWords(ev.name, serviceNames.byId);
          else if (ev.type === 'done') {
            reply.text = ev.text;
            if (ev.choices?.length) reply.choices = ev.choices;
            if (ev.bug) reply.bug = ev.bug;
            if (ev.updates) reply.updates = ev.updates;
            reply.pending = false;
            reply.at = new Date().toISOString();
          } else if (ev.type === 'error') {
            if (ev.signIn) hold({ turnId, signIn: ev.signIn });
            reply.text = ev.message;
            reply.pending = false;
            reply.failed = true;
          }
          scrollDown();
        }
      }
      if (reply.pending)
        throw new Error(
          'The connection closed before the reply arrived. Check the chat before sending again.'
        );
    } catch (err) {
      reply.text = err instanceof Error ? err.message : String(err);
      reply.failed = true;
    } finally {
      reply.pending = false;
      if (generation === newest) {
        sending = false;
        remoteBusy = false;
        active = undefined;
        status = '';
        onend();
        scrollDown();
        load(profile.id);
      }
    }
  }

  // A chat started from a report arrives as a draft: add it to the box and
  // put the cursor at the end, for the owner to say what the owner wants. One
  // started from the agents search arrives empty and only takes the cursor.
  $effect(() => {
    if (chatRequest.drafts[profile.id] === undefined || !visible) return;
    const d = takeDraft(profile.id) ?? '';
    if (d) typed('');
    // A draft the box already holds, say from pressing Use in chat twice, goes in once.
    if (d && !draft.includes(d.trim())) draft = draft.trim() ? `${draft.trimEnd()}\n\n${d}` : d;
    void tick().then(() => {
      fit();
      box?.focus();
      box?.setSelectionRange(draft.length, draft.length);
    });
  });

  // The input grows with what the owner types, up to most of the panel. Dragging
  // the bar above it sets how tall it is at least, and that height is kept.
  // As tall as the plus button over Send beside it (32 + 6 + 38).
  const MIN_INPUT = 76;
  let box: HTMLTextAreaElement | undefined = $state();
  let root: HTMLDivElement | undefined = $state();
  let floor = $state(MIN_INPUT);
  try {
    floor = Math.max(MIN_INPUT, Number(localStorage.getItem('oddboro.chat.input')) || MIN_INPUT);
  } catch {
    // No storage: start at one line.
  }
  const ceiling = () => Math.max(MIN_INPUT, (root?.clientHeight ?? 600) * 0.6);

  function fit() {
    if (!box) return;
    // Measured first: the brief auto height below scrolls the list on its own.
    const pinned = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 8 : false;
    box.style.blockSize = 'auto';
    // At least as tall as the column beside it: the files, the plus button and Send.
    box.style.blockSize = `${Math.min(ceiling(), Math.max(floor, side, box.scrollHeight))}px`;
    if (pinned && list) list.scrollTop = list.scrollHeight;
  }
  /** The height of the column at the box's end side, which grows as files are attached. */
  let side = $state(0);
  $effect(() => {
    void draft;
    void floor;
    void visible;
    void side;
    fit();
  });

  let pull: { y: number; h: number } | undefined;
  function grab(e: PointerEvent) {
    pull = { y: e.clientY, h: box?.offsetHeight ?? floor };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function drag(e: PointerEvent) {
    // The input sits at the bottom, so pulling the bar up makes it taller.
    if (pull)
      floor = Math.round(Math.min(ceiling(), Math.max(MIN_INPUT, pull.h + pull.y - e.clientY)));
  }
  function release() {
    if (!pull) return;
    pull = undefined;
    keep();
  }
  function nudge(e: KeyboardEvent) {
    const step = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
    if (!step) return;
    e.preventDefault();
    floor = Math.min(ceiling(), Math.max(MIN_INPUT, floor + step));
    keep();
  }
  function keep() {
    try {
      localStorage.setItem('oddboro.chat.input', String(floor));
    } catch {
      // Private window: the height lasts this visit only.
    }
  }

  // Files the owner attaches. Pasting or dropping puts each one's tag, like
  // [Image #1], at the caret; Attach files in the plus menu adds them to the
  // tray alone. The tray over the plus button shows everything that will go.
  let pending = $state<Pending[]>([]);
  let nextKey = 0;
  let uploading = $state(false);
  const decisionMode = $derived(
    !pending.length && !about && !active && !sending && !remoteBusy && !uploading && !stopping
  );

  /** Why the last file was turned away, under the tray. */
  let refused = $state('');
  let dragging = $state(false);
  let picker: HTMLInputElement | undefined = $state();

  // The plus menu beside the box: one list of what the owner can add, each
  // shown where it applies. A new action is one more item here.
  let goalOpen = $state(false);
  let goal: ChatGoal | undefined = $state();
  const canSetGoal = $derived(profile.role === 'Office Manager' && !replyTo && decisionMode);
  /** `focuses`: the item puts the caret somewhere itself, so focus does not go back to the message box. */
  type MoreItem = { label: string; shown: () => boolean; run: () => void; focuses?: boolean };
  const MORE: MoreItem[] = [
    { label: 'Attach files', shown: () => true, run: () => picker?.click() },
    {
      label: 'Project sessions',
      shown: () => advanced.on,
      focuses: true,
      run: () => openProject()
    },
    {
      label: 'New goal',
      shown: () => canSetGoal,
      focuses: true,
      run: async () => {
        goalOpen = true;
        await tick();
        goal?.focus();
      }
    },
    // The form takes the focus; a failed reply's error starts its details.
    {
      label: 'Report a bug',
      shown: () => true,
      focuses: true,
      run: () => (bugReport = { body: failedReply(lines) })
    }
  ];
  const more = $derived(MORE.filter((m) => m.shown()));
  let moreOpen = $state(false);
  let moreButton: HTMLButtonElement | undefined = $state();
  let moreMenu: HTMLDivElement | undefined = $state();
  const moreItems = () => [...(moreMenu?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

  async function openMore() {
    moreOpen = true;
    await tick();
    moreItems()[0]?.focus();
  }
  function closeMore(focus?: HTMLElement) {
    moreOpen = false;
    focus?.focus();
  }
  function pickMore(m: MoreItem) {
    closeMore(m.focuses ? undefined : box);
    m.run();
  }
  /** Arrow keys move between the items, Escape closes; Enter picks the focused one as a button does. */
  function moreKey(e: KeyboardEvent) {
    const items = moreItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') closeMore(moreButton);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items.at(-1)?.focus();
    else return;
    e.preventDefault();
  }
  /** A click outside the menu and its button closes it. */
  function outside(e: PointerEvent) {
    const at = e.target as Node;
    if (moreOpen && !moreMenu?.contains(at) && !moreButton?.contains(at)) closeMore();
  }
  // The menu goes with the box: it closes while the box is disabled.
  $effect(() => {
    if (saving) moreOpen = false;
  });
  // The goal field closes where New goal does not show, as it did when it went away.
  $effect(() => {
    if (!canSetGoal) goalOpen = false;
  });

  const attachmentUrl = (f: ChatFile) =>
    `/api/staff/${profile.id}/attachments/${encodeURIComponent(f.name)}`;

  function attach(files: File[], how: 'paste' | 'drop' | 'pick') {
    const taken = [...pending.map((p) => p.tag), ...(waiting?.files.map((f) => f.tag) ?? [])];
    const added: Pending[] = [];
    refused = '';
    for (const file of files) {
      const why = refusal(file.name, file.type, file.size);
      if (why) {
        refused = why;
        continue;
      }
      if (pending.length + added.length >= FILES_MAX) {
        refused = `Attach up to ${FILES_MAX} files at a time.`;
        break;
      }
      const mediaType = attachableType(file.name, file.type)!;
      added.push({
        key: nextKey++,
        tag: tagFor(file, how === 'paste', [...taken, ...added.map((a) => a.tag)]),
        mediaType,
        size: file.size,
        file,
        url: isPicture(mediaType) ? URL.createObjectURL(file) : undefined,
        inline: how !== 'pick'
      });
    }
    if (!added.length) return;
    pending = [...pending, ...added];
    const inline = added.filter((a) => a.inline).map((a) => a.tag);
    if (inline.length && box) {
      const put = withTokens(draft, box.selectionStart, box.selectionEnd, inline);
      draft = put.text;
      void tick().then(() => {
        box?.focus();
        box?.setSelectionRange(put.caret, put.caret);
      });
    }
  }

  /** Let go of a picture's preview made on this page. */
  function unpreview(p: Pending) {
    if (p.url && p.file) URL.revokeObjectURL(p.url);
  }
  function remove(key: string | number) {
    const p = pending.find((x) => x.key === key);
    if (!p) return;
    unpreview(p);
    pending = pending.filter((x) => x !== p);
    if (p.inline) draft = withoutToken(draft, p.tag);
  }
  function clearTray() {
    pending.forEach(unpreview);
    pending = [];
    refused = '';
  }
  // Deleting a tag from the text drops its file, as in Claude Code.
  $effect(() => {
    const text = draft;
    const gone = untrack(() => pending.filter((p) => p.inline && !hasToken(text, p.tag)));
    if (!gone.length) return;
    gone.forEach(unpreview);
    pending = untrack(() => pending.filter((p) => !gone.includes(p)));
  });

  /** Keep each file in the Odd's attachments folder, in the tray's order. */
  function toAttachments(items: Pending[]): Promise<ChatFile[]> {
    return Promise.all(
      items.map(async (p) => {
        if (p.kept) return p.kept;
        const file = p.file!;
        const kept = await sendFile<Omit<ChatFile, 'tag'>>(
          `/api/staff/${profile.id}/attachments`,
          file,
          file.name || p.tag,
          p.mediaType
        );
        return { ...kept, tag: p.tag };
      })
    );
  }

  function onpaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    const files = [...(data?.files ?? [])];
    // Copied cells or text often bring a picture of themselves: the text wins.
    if (!files.length || data?.getData('text/plain')) return;
    e.preventDefault();
    attach(files, 'paste');
  }
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  function ondragover(e: DragEvent) {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dragging = true;
  }
  function ondragleave(e: DragEvent) {
    const into = e.relatedTarget as Node | null;
    if (!into || !(e.currentTarget as HTMLElement).contains(into)) dragging = false;
  }
  function ondrop(e: DragEvent) {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragging = false;
    attach([...(e.dataTransfer?.files ?? [])], 'drop');
  }
  function picked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    attach([...(input.files ?? [])], 'pick');
    // The same file can be picked again after it is removed.
    input.value = '';
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    // Ctrl+Enter on every system, as in Claude Code: queue the box and add it to the running reply.
    if (e.ctrlKey && (sending || remoteBusy) && active && addsToReply) void submit(true);
    else (e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
  }
</script>

<!-- A hand-off text: its opening paragraph until the owner opens the rest. -->
{#snippet full(text: string, key: string, staff: string)}
  {@const short = lead(text)}
  {@const open = opened.has(key)}
  <div class={!open && short.text.length > LONG ? 'clamped max-h-40 overflow-hidden' : ''}>
    <Markdown text={open ? text : short.text} {staff} />
  </div>
  {#if short.more || short.text.length > LONG}
    <button class="mt-1 text-xs text-muted hover:text-ink" onclick={() => toggle(key)}
      >{open ? 'Show less' : 'Show all'}</button
    >
  {/if}
{/snippet}

<!-- The whole of a hand-off, in the giver's chat: what it asked, and what came back. -->
{#snippet story(h: HandOffLine)}
  <div class="mt-2 flex flex-col gap-2 border-t border-sea/20 pt-2 text-ink">
    <div>
      <span class="block text-xs text-muted">{h.from} asked</span>
      {@render full(h.brief, `${h.id}-brief`, h.fromId)}
    </div>
    {#each h.backs as b, n (n)}
      <div class="border-s-2 border-sea ps-2">
        <span class="block text-xs text-muted"
          >{b.answered ? 'You answered' : `${h.to} replied`} · {when(b.at)}</span
        >
        {@render full(b.text, `${h.id}-back-${n}`, h.toId)}
      </div>
    {:else}
      <span class="text-xs text-muted">{h.to} has not replied yet.</span>
    {/each}
  </div>
{/snippet}

<!-- Where the Odd asked a colleague, on its thread's card: one line whose status moves, the story inside. -->
{#snippet gave(h: HandOffLine)}
  {@const p = handOffProgress(h, nowOf)}
  <div class="rounded-xl border border-sea/40 px-3 py-2">
    <button
      class="flex w-full items-baseline gap-2 text-start"
      aria-expanded={opened.has(`${h.id}-card`)}
      onclick={() => toggle(`${h.id}-card`)}
    >
      <span class="min-w-0 flex-1">
        <span class="block text-xs text-muted">↳ Asked {h.to} · {when(h.at)}</span>
        <span class="block font-medium break-words text-ink">{h.title}</span>
      </span>
      <span class="text-xs text-sea">{opened.has(`${h.id}-card`) ? 'Close' : 'Open'}</span>
    </button>
    <span class="text-xs {p.yours ? 'text-ember' : 'text-muted'}">{p.text}</span>
    {#if opened.has(`${h.id}-card`)}{@render story(h)}{/if}
  </div>
{/snippet}

<!-- What the Odd is doing, under the reply it is working on, with Stop beside it. -->
{#snippet doing(extra: string)}
  <div class="meta {extra} ms-1 me-auto flex items-center text-xs text-muted">
    <span aria-live="polite">{profile.name} is {status ? status.toLowerCase() : 'replying'}…</span>
    {#if active}
      <button type="button" class="text-coral hover:text-ink" disabled={stopping} onclick={stop}
        >Stop</button
      >
    {/if}
  </div>
{/snippet}

<!-- The line under a message: when, how long its run took, Reply when there is something to reply about, then Copy, split by thin bars. -->
{#snippet meta(line: Line, i: number)}
  <div
    class="meta -mt-1 flex items-center text-[11px] leading-none text-faint {line.from === 'owner'
      ? 'owner ms-auto me-1'
      : 'ms-1 me-auto'}"
  >
    {#if line.at}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: focusing the time shows its full date, as hovering does. -->
      <span class="stamp" tabindex="0">
        <time datetime={line.at}>{stamp(line.at, new Date(clock))}</time>
        <span class="tip" role="tooltip">{fullDate(line.at)}</span>
      </span>
    {/if}
    {#if line.took}<span>{took(line.took)}</span>{/if}
    {#if line.item}
      {@const it = line.item}
      <button
        class="hover:text-ink"
        aria-label={`Reply about ${it.title}`}
        onclick={() => reply(it)}>Reply</button
      >
    {/if}
    <button
      class="stamp hover:text-ink"
      aria-label={copied === i ? 'Copied' : line.item ? 'Copy this card' : 'Copy this message'}
      onclick={() => copy(i, line.item ? cardCopy(line.item) : line.text)}
    >
      <svg
        class="size-3"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        aria-hidden="true"
        ><rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" /><path
          d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"
        /></svg
      >
      {#if copied === i}<span class="tip shown" aria-live="polite">Copied</span>{/if}
    </button>
  </div>
{/snippet}

<div class="flex h-full min-h-0 flex-col" bind:this={root}>
  {#if profile.persona}
    <div class="flex flex-col gap-2 border-b border-hairline p-3 text-xs">
      <p class="leading-relaxed text-muted">{profile.persona.disclosure}</p>
      {#if profile.persona.quiet}
        <PersonaQuiet
          slug={profile.persona.slug}
          name={profile.name}
          quiet={profile.persona.quiet}
        />
      {/if}
    </div>
  {/if}
  <div
    bind:this={list}
    {@attach pin}
    class="flex flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-3"
  >
    {#if loaded && lines.length === 0}
      <p class="m-auto max-w-[240px] text-center text-sm text-muted">
        Say hello to {profile.name}, who walks to your office while you talk.
      </p>
    {/if}
    {#each lines as line, i (line.item ? keyOf(line.item) : i)}
      {#if breaks[i]}
        <!-- A new day in the office's time zone. -->
        <div class="flex items-center gap-2 py-1 text-[11px] text-faint">
          <span class="h-px flex-1 bg-hairline"></span>{breaks[i]}<span
            class="h-px flex-1 bg-hairline"
          ></span>
        </div>
      {/if}
      {#if line.lesson}
        <Lesson lesson={line.lesson} name={profile.name} />
      {:else if line.thread}
        <!-- One card per piece of work the Odd leads: where it stands, and each step on Open. -->
        {@const t = line.thread.line}
        {@const p = workLine({ ...t, lead: t.hub })}
        {@const key = `thread-${t.id}`}
        <div
          class="me-auto w-[85%] rounded-2xl rounded-es-md border border-sea/40 px-3 py-2 text-sm"
        >
          <button
            class="flex w-full items-baseline gap-2 text-start"
            aria-expanded={opened.has(key)}
            onclick={() => toggle(key)}
          >
            <span class="min-w-0 flex-1">
              <span class="block font-medium break-words text-ink">{t.title}</span>
              <span class="block text-xs text-muted">{when(t.at)}</span>
            </span>
            <span class="text-xs text-sea">{opened.has(key) ? 'Close' : 'Open'}</span>
          </button>
          <span class="text-xs {p.yours ? 'text-ember' : 'text-muted'}">{p.text}</span>
          {#each t.waiting as w (`${w.kind}-${w.id}`)}
            <button
              class="mt-1 block text-start text-xs text-ember hover:text-ink"
              onclick={() => pick(w)}>{KIND[w.kind]}: {w.title}</button
            >
          {/each}
          {#if opened.has(key)}
            <div class="mt-2 flex flex-col gap-2 border-t border-sea/20 pt-2 text-ink">
              {#each threadSteps(line.thread) as s, n (n)}
                {#if 'h' in s}
                  {@render gave(s.h)}
                {:else}
                  <div class="border-s-2 border-sea ps-2">
                    <span class="block text-xs text-muted"
                      >{t.hub} picked it back up · {when(s.at)}{s.run.outcome
                        ? ''
                        : ' · working'}</span
                    >
                    {#if s.run.text}{@render full(s.run.text, `${key}-run-${n}`, profile.id)}{/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {:else if line.handOff}
        {@const h = line.handOff.line}
        {@const step = line.handOff.step}
        {@const p = handOffProgress(h, nowOf)}
        {#if step === 'given'}
          <!-- In the colleague's chat, the hand-off is the giver asking. -->
          <div class="-mb-1 ms-1 text-[10px] tracking-[0.16em] text-sea uppercase">
            {h.from} asked{line.at ? ` · ${when(line.at)}` : ''}
          </div>
          <div
            class="me-auto max-w-[85%] rounded-2xl rounded-es-md border-s-2 border-sea bg-raise px-3 py-2 text-sm leading-relaxed break-words text-ink"
          >
            <span class="mb-1 block font-medium">{h.title}</span>
            {@render full(h.brief, `${h.id}-brief`, h.fromId)}
          </div>
          {#if !h.backs.length}
            <div class="-mt-1 ms-1 text-xs text-muted">{p.text}</div>
          {/if}
        {:else}
          <!-- The colleague's reply in its own chat, or the giver's pick-up in the giver's. -->
          {@const reply = step === 'reply'}
          {@const n = line.handOff.back ?? 0}
          {@const b = h.backs[n]}
          {@const text = (reply ? b?.text : b?.pickUp.text) ?? ''}
          {#if reply}
            <div class="-mb-1 ms-1 text-[10px] tracking-[0.16em] text-sea uppercase">
              Reply to {h.from}{line.at ? ` · ${when(line.at)}` : ''}
            </div>
          {/if}
          <div
            class="me-auto max-w-[85%] rounded-2xl rounded-es-md bg-raise px-3 py-2 text-sm leading-relaxed break-words text-ink"
          >
            {@render full(text, `${h.id}-${step}-${n}`, reply ? h.toId : h.fromId)}
            {#if !reply}
              <button
                class="mt-2 block text-start text-xs text-sea hover:text-ink"
                aria-expanded={opened.has(`${h.id}-from`)}
                onclick={() => toggle(`${h.id}-from`)}>↳ From {h.to}'s work: {h.title}</button
              >
              {#if opened.has(`${h.id}-from`)}{@render story(h)}{/if}
            {/if}
          </div>
          {#if reply && n === h.backs.findLastIndex((x) => !x.answered) && (h.status === 'waiting' || (h.status === 'failed' && !h.answered))}
            <!-- How it stands, under the colleague's latest reply, when the owner has to know: the giver's card says it too. -->
            <div class="-mt-1 ms-1 text-xs {h.status === 'waiting' ? 'text-ember' : 'text-muted'}">
              {h.status === 'waiting' ? 'Waiting on you' : 'Could not finish'}
            </div>
          {/if}
        {/if}
      {:else if line.item}
        {@const it = line.item}
        {@const box = `block w-full rounded-2xl rounded-es-md bg-raise px-3 py-2 text-start text-sm ${
          selected === keyOf(it) ? 'ring-1 ring-sea' : ''
        }`}
        <div class="-mb-1 ms-1 text-[10px] tracking-[0.16em] text-sea uppercase">
          {KIND[it.kind]}
        </div>
        <div class="me-auto w-[85%]" data-item={keyOf(it)}>
          {#snippet face()}
            <span class="block font-medium break-words text-ink">{it.title}</span>
            <span class="flex flex-wrap items-baseline gap-x-3 text-xs">
              <span
                class={it.status === 'open' || it.status === 'new' ? 'text-ember' : 'text-muted'}
                >{STATUS[it.status] ?? it.status}</span
              >
              {#if opens(it)}
                <span class="text-sea"
                  >{it.kind === 'report' && !desk.reports.some((r) => r.id === it.id)
                    ? 'Open report'
                    : 'Open on Desk'}</span
                >
              {/if}
            </span>
          {/snippet}
          <!-- The whole card opens it, its title still selectable: a click that ends a selection opens nothing. Its controls sit below, outside the button. -->
          {#if opens(it)}
            <button
              type="button"
              class="{box} cursor-pointer select-text hover:bg-sea/10 focus-visible:ring-1 focus-visible:ring-sea focus-visible:outline-none"
              aria-current={selected === keyOf(it) ? 'true' : undefined}
              onclick={() => {
                if (!window.getSelection()?.toString()) pick(it);
              }}>{@render face()}</button
            >
          {:else}
            <div class={box} aria-current={selected === keyOf(it) ? 'true' : undefined}>
              {@render face()}
            </div>
          {/if}
          {#if it.note}
            <p class="mt-1 px-3 text-xs whitespace-pre-wrap text-muted">{it.note}</p>
          {/if}
          {#if it.status === 'open'}
            {@const a = proposal(it)}
            {@const t = question(it)}
            {#if a}
              <dl class="mt-2 px-2">
                {#if a.why}<div class="mb-2 text-xs text-muted">{a.why}</div>{/if}
                <GoalProposal
                  {a}
                  {staff}
                  skip={skipped[a.id] ?? {}}
                  onskip={(i, value) => {
                    skipped[a.id] = { ...skipped[a.id], [i]: value };
                  }}
                />
              </dl>
              <div class="mt-2 flex gap-2">
                <button
                  class="choice"
                  disabled={saving || !decisionMode}
                  onclick={() => reply(it, 'change')}>Change</button
                >
                <button
                  class="choice"
                  disabled={saving || !decisionMode || picks(a)?.length === 0}
                  onclick={() => decide(it, 'approve')}
                  >{a.goal
                    ? 'Set the goal'
                    : `Approve ${picks(a)?.length} of ${a.plan?.items.length}`}</button
                >
              </div>
            {:else if t}
              <div class="mt-2 px-2 text-xs text-muted">
                <p>{t.why}</p>
                {#if t.steps.length}
                  <ol class="list-decimal ps-4">
                    {#each t.steps as step, n (n)}<li>{step.text}</li>{/each}
                  </ol>
                {/if}
                {#if t.choice}
                  <!-- A tap is the answer: it finishes the task, as the Desk's choice and Mark done would. -->
                  <div class="mt-2 flex flex-col gap-1.5" role="group" aria-label="Choices">
                    {#each t.choice.options as option (option)}
                      <button
                        class="choice"
                        disabled={saving || !decisionMode}
                        onclick={() => decide(it, 'choose', option)}>{option}</button
                      >
                    {/each}
                  </div>
                {:else}
                  <!-- The one place the chat takes a typed answer to a task. -->
                  <TaskResponse
                    task={t.task}
                    odd={profile.name}
                    files={t.files}
                    open
                    inChat
                    held={saving || !decisionMode}
                    onfinish={() => load(profile.id)}
                  />
                {/if}
              </div>
            {/if}
          {:else if it.kind === 'task' && it.responseVersion}
            <details
              class="mt-1 px-3 text-xs text-muted"
              ontoggle={(e) => e.currentTarget.open && readResponse(it.id)}
            >
              <summary class="cursor-pointer text-sea">Your response</summary>
              <p class="mt-1 whitespace-pre-wrap text-ink">
                {saved[it.id]?.response ?? unread[it.id] ?? 'Opening'}
              </p>
            </details>
          {/if}
          {#if it.kind === 'ask' && (it.switches || it.folder?.given || (it.folder && it.status === 'open'))}
            <!-- The Desk's folder and switch handlers, answered where the work stopped. -->
            {#key it.id}
              <ChatAccessAsk item={it} name={profile.name} onchanged={() => load(profile.id)} />
            {/key}
          {/if}
        </div>
        {@render meta(line, i)}
      {:else}
        {#if line.re}
          <!-- The owner's line replies about a card; an Odd's told line answers what the owner said on it. -->
          <button
            class="-mb-1 max-w-[85%] truncate text-[10px] text-faint hover:text-ink {line.from ===
            'owner'
              ? 'me-1 ms-auto'
              : 'ms-1 me-auto'}"
            title={`Open ${line.re.title}`}
            onclick={() => line.re && pick(line.re)}>↩ {line.re.title}</button
          >
        {/if}
        {#if line.poke}
          <div class="-mb-1 ms-1 text-[10px] tracking-[0.16em] text-ember uppercase">Poke</div>
        {/if}
        {#if line.files?.length}
          <div class="ms-auto max-w-[85%]">
            <ChatFiles
              end
              files={line.files.map((f) => ({ ...f, key: f.name, url: attachmentUrl(f) }))}
            />
          </div>
        {/if}
        <div
          class="max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words
          {line.from === 'owner'
            ? 'ms-auto rounded-ee-md bg-sea/25 whitespace-pre-wrap text-ink'
            : `me-auto rounded-es-md bg-raise ${line.failed || line.runFailed ? 'text-coral whitespace-pre-wrap' : 'text-ink'}`}"
        >
          {#if line.pending && !line.text}
            <span class="dots" aria-label="Replying"><span></span><span></span><span></span></span>
          {:else if line.from === 'staff' && !line.failed}
            <!-- While it streams, its choice lines wait to become buttons. -->
            <Markdown
              text={line.pending ? hideChoiceLines(line.text) : line.text}
              staff={profile.id}
            />
          {:else}
            {line.text}
          {/if}
        </div>
        {#if line.bug && !line.pending}
          <!-- The Odd drafted a bug report: the form opens with it, and files nothing by itself. -->
          <div class="ms-auto w-[85%]">
            <button class="choice" onclick={() => (bugReport = line.bug)}
              >File this bug report</button
            >
          </div>
        {/if}
        {#if line === latestUpdate && !line.pending}
          <div class="my-3 rounded-lg border border-line p-3">
            <UpdatesSection showWindow={false} />
          </div>
        {/if}
        {#if retryable(line, i)}
          {#if blocked && blocked.turnId === line.turnId}
            <ChatSignInCard
              request={blocked.signIn}
              name={profile.name}
              onready={() => continueChat(line.turnId!)}
              onedit={() => hold()}
            />
          {:else}
            <button
              class="ms-auto text-xs text-sea hover:text-ink"
              onclick={() => say(line.text, line.re, line.files ?? [], line)}>Retry reply</button
            >
          {/if}
        {/if}
        {#if line.pending}
          {@render doing('-mt-1')}
        {:else}
          {@render meta(line, i)}
        {/if}
      {/if}
    {/each}
    {#if active && !lines.some((l) => l.pending)}
      <!-- A reply still running from before this chat opened. -->
      {@render doing('')}
    {/if}
    {#if waiting}
      <!-- Sent while the reply above was still coming: it goes when that reply ends. -->
      <div class="ms-auto flex max-w-[85%] flex-col items-end gap-0.5">
        {#if waiting.files.length}
          <ChatFiles
            end
            files={waiting.files.map((f) => ({ ...f, key: f.name, url: attachmentUrl(f) }))}
          />
        {/if}
        {#if waiting.text}
          <div
            class="rounded-2xl rounded-ee-md border border-dashed border-sea/40 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink"
          >
            {waiting.text}
          </div>
        {/if}
        <div class="flex items-center gap-3 pe-1 text-[10px] text-faint">
          {#if offersNow(waiting)}
            <button
              class="text-sea hover:text-ink disabled:opacity-40"
              disabled={adding || !!waiting.files.length}
              title={waiting.files.length
                ? `Send now cannot carry files. This goes when ${profile.name} finishes.`
                : `Add this to ${profile.name}'s reply now`}
              onclick={sendNow}>Send now (Ctrl+Enter)</button
            >
            <span class="h-3 border-s border-hairline" aria-hidden="true"></span>
          {/if}
          <span>Queued</span>
          <button class="hover:text-coral" onclick={unwait}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if answers.list.length}
      <!-- Each answer a full-width choice on the owner's side; a first question's default is first and marked. -->
      <div class="ms-auto flex w-[85%] flex-col gap-1.5" role="group" aria-label="Answers">
        {#each answers.list as a, n (a)}
          <button class="choice" onclick={() => say(a)}>
            <span class="min-w-0 flex-1">{a}</span>
            {#if answers.first && n === 0}<span class="default">Default</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
    <!-- A poke to come keeps its words until it lands as a message, at the bottom. -->
    {#each upcoming as p (p.id)}
      <div class="me-auto ms-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>{profile.name} will message you at {clockTime(new Date(p.at))}.</span>
        <button class="text-sea hover:text-ink" onclick={() => pokeNow(p)}>Send now</button>
        <button
          class="text-faint hover:text-coral"
          aria-label={`Cancel the ${clockTime(new Date(p.at))} poke`}
          onclick={() => cancel(p)}>Cancel</button
        >
      </div>
    {/each}
  </div>

  {#if work.length}
    <!-- What the Odd is working on now, one line each; a click opens In progress. -->
    <div
      class="flex flex-col gap-0.5 border-t border-hairline px-3 py-1.5 text-start text-xs text-muted transition-colors hover:bg-raise"
    >
      {#each work as w (w.id)}
        <span class="flex w-full min-w-0 items-center gap-1.5">
          <span class="size-1.5 shrink-0 rounded-full {w.queued ? 'bg-faint' : 'bg-ember'}"></span>
          <button
            class="min-w-0 truncate text-ink hover:underline"
            title="Open In progress"
            onclick={onwork}>{w.label}</button
          >
          <span class="shrink-0 text-faint"
            >· {w.toStart
              ? 'waiting to start'
              : w.queued
                ? 'waiting for a free slot'
                : runningFor(w.since, clock)}</span
          >
          {#if !w.queued}
            <span class="min-w-0 truncate"
              >· {w.doing ? toolWords(w.doing, serviceNames.byId) : 'Thinking'}</span
            >
          {/if}
          {#if w.about && !w.queued}
            {@const target = w.about}
            <button
              class="ms-auto min-w-0 truncate text-sea"
              title={`Message ${target.lead} about ${target.title}`}
              onclick={() => direct(target)}
              >{target.kind === 'goal' ? target.title + ' · ' : ''}Message {target.lead}</button
            >
          {/if}
        </span>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: a focusable separator is the ARIA pattern for a keyboard-resizable pane. -->
  <div
    class="grip"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize the message box"
    aria-valuenow={floor}
    tabindex="0"
    onpointerdown={grab}
    onpointermove={drag}
    onpointerup={release}
    onpointercancel={release}
    onkeydown={nudge}
  ></div>
  {#if decisionMode && !replyTo && approveTo && approveTo.id === onlyProposal?.id && approveWord(draft)}
    <p class="px-3 pb-1 text-xs text-muted">Approving “{approveTo.title}”</p>
  {/if}
  {#if replyTo}
    <div class="flex items-center gap-2 px-3 pb-1.5 text-xs text-muted">
      <span class="min-w-0 flex-1 truncate"
        >{intent === 'change' ? 'Asking for changes to' : 'Replying about'}
        {KIND[replyTo.kind].toLowerCase()} “{replyTo.title}”</span
      >
      <button
        class="shrink-0 px-1 text-faint hover:text-coral"
        aria-label="Stop replying"
        disabled={saving}
        onclick={() => {
          replyTo = undefined;
          intent = 'reply';
          refused = '';
        }}>✕</button
      >
    </div>
  {/if}
  {#if about}
    <div class="flex gap-2 px-3 pb-1.5 text-xs text-muted">
      <span>To {about.lead} about {about.kind}: {about.title}</span>
      <button aria-label="Clear work selection" onclick={() => (about = undefined)}>✕</button>
    </div>
  {/if}
  {#if canSetGoal}
    <ChatGoal
      bind:this={goal}
      managerId={profile.id}
      onset={() => load(profile.id)}
      bind:open={goalOpen}
    />
  {/if}
  <form
    class="flex items-end gap-2 px-3 {refused ? 'pb-2' : 'pb-3'}"
    novalidate
    onsubmit={send}
    {ondragover}
    {ondragleave}
    {ondrop}
  >
    <input
      bind:this={picker}
      type="file"
      multiple
      accept={ACCEPT}
      class="hidden"
      onchange={picked}
    />
    <textarea
      bind:this={box}
      class="min-h-[76px] flex-1 resize-none overflow-y-auto rounded-lg bg-raise px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-faint {dragging
        ? 'ring-1 ring-sea'
        : ''}"
      rows="1"
      placeholder={dragging
        ? 'Drop to attach'
        : replyTo
          ? `Reply to ${profile.name}`
          : `Message ${profile.name}`}
      oninput={(e) =>
        typed(
          decisionMode &&
            e instanceof InputEvent &&
            e.isTrusted &&
            e.inputType !== 'insertFromPaste' &&
            e.inputType !== 'insertFromDrop'
            ? e.currentTarget.value
            : ''
        )}
      disabled={saving}
      bind:value={draft}
      {onkeydown}
      {onpaste}></textarea>
    <div class="flex shrink-0 flex-col gap-1.5" bind:clientHeight={side}>
      {#if pending.length}
        <!-- What goes with the message, over the plus button: three files tall at most, scrolling past that. -->
        <div
          class="tray -me-3 flex justify-center overflow-y-auto overscroll-contain ps-1.5 pe-1.5 pt-1.5"
          aria-label="Attached files"
        >
          <ChatFiles stack files={pending} onremove={remove} />
        </div>
      {/if}
      <div class="relative flex flex-col">
        {#if moreOpen}
          <div
            bind:this={moreMenu}
            class="absolute end-0 bottom-full z-20 mb-1 flex min-w-36 flex-col rounded-lg border border-hairline bg-panel-solid py-1"
            role="menu"
            aria-label="More"
            tabindex="-1"
            onkeydown={moreKey}
          >
            {#each more as m (m.label)}
              <button
                type="button"
                role="menuitem"
                tabindex="-1"
                class="px-3 py-1.5 text-start text-sm whitespace-nowrap text-ink outline-none hover:bg-sea/15 focus:bg-sea/15"
                onclick={() => pickMore(m)}>{m.label}</button
              >
            {/each}
          </div>
        {/if}
        <button
          bind:this={moreButton}
          type="button"
          class="flex h-8 items-center justify-center rounded-lg text-muted hover:bg-raise hover:text-ink disabled:opacity-40"
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="Attach files and more"
          disabled={saving}
          onclick={() => (moreOpen ? closeMore() : openMore())}
        >
          <!-- A plus: one stroke down, one across. -->
          <svg
            class="size-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"><path d="M8 3v10" /><path d="M3 8h10" /></svg
          >
        </button>
      </div>
      <button
        class="flex h-[38px] items-center justify-center gap-1.5 rounded-lg bg-sea px-3 text-sm font-medium text-night disabled:opacity-40"
        disabled={saving || (!draft.trim() && !pending.length) || uploading}
      >
        <!-- A paper plane: its wings, and the fold down its middle. -->
        <svg
          class="size-4 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M14.5 1.5 1.5 6.6l5.2 2.2 2.2 5.7z" /><path d="M14.5 1.5 6.7 8.8" /><path
            d="m6.7 8.8.2 3.7 2-1.9"
          /></svg
        >{uploading ? 'Attaching' : decisionMode && intent === 'change' ? 'Send changes' : 'Send'}
      </button>
    </div>
  </form>
  {#if refused}
    <p class="px-3 pb-3 text-xs text-coral" role="alert">{refused}</p>
  {/if}
</div>

<svelte:window onpointerdown={outside} />

{#if bugReport !== undefined}
  <BugReport
    initial={bugReport}
    staff={profile.id}
    onclose={() => (bugReport = undefined)}
    onfiled={() => {
      if (!sending) load(profile.id);
    }}
  />
{/if}

<style>
  /* Three attached files at most (each 48px square, 2px and a 15px name under
     it, 8px apart, 6px over the first for its ✕); the rest scroll. */
  .tray {
    max-block-size: calc(3 * 65px + 2 * 8px + 6px);
  }
  .grip {
    position: relative;
    block-size: 12px;
    border-block-start: 1px solid var(--color-hairline);
    cursor: row-resize;
    touch-action: none;
  }
  .grip::after {
    content: '';
    position: absolute;
    inset-block-start: 4px;
    inset-inline: calc(50% - 16px);
    block-size: 3px;
    border-radius: 3px;
    background: var(--color-hairline);
  }
  .grip:hover::after,
  .grip:focus-visible::after {
    background: var(--color-muted);
  }
  .grip:focus-visible {
    outline: none;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
    padding: 4px 0;
  }
  .dots span {
    width: 5px;
    height: 5px;
    border-radius: 99px;
    background: var(--color-muted);
    animation: blink 1.2s infinite ease-in-out;
  }
  .dots span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .dots span:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }
  /* The line under a message: its parts split by a thin bar. */
  .meta > * + * {
    margin-inline-start: 0.5rem;
    padding-inline-start: 0.5rem;
    border-inline-start: 1px solid var(--color-hairline);
  }
  .meta button {
    padding-block: 2px;
  }
  /* The full date over a time, and Copied over the copy button: CSS only. */
  .stamp {
    position: relative;
    border-radius: 3px;
  }
  .stamp:focus-visible {
    outline: 1px solid var(--color-sea);
    outline-offset: 2px;
  }
  .tip {
    position: absolute;
    inset-block-end: calc(100% + 6px);
    inset-inline-start: -4px;
    z-index: 10;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--color-panel-solid);
    box-shadow: var(--shadow-float);
    color: var(--color-ink);
    font-size: 11px;
    line-height: 1.2;
    white-space: nowrap;
    pointer-events: none;
    visibility: hidden;
  }
  .owner .tip {
    inset-inline-start: auto;
    inset-inline-end: -4px;
  }
  .stamp:hover .tip,
  .stamp:focus-visible .tip,
  .tip.shown {
    visibility: visible;
  }
  .choice:first-child {
    border-color: color-mix(in srgb, var(--color-sea) 55%, transparent);
  }
  .default {
    flex-shrink: 0;
    color: var(--color-sea);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  /* A long hand-off text fades out where it is cut, until the owner opens it. */
  .clamped {
    mask-image: linear-gradient(to bottom, black 70%, transparent);
  }
</style>
