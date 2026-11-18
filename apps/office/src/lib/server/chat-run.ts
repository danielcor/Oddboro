// A saved owner turn, its current attempt and its reply. Closing a page never
// cancels work; Stop and Send now name one attempt in the live registry.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  staffer,
  ownerName,
  deliveries,
  ownTools,
  currentPlatform,
  home,
  OFFICE_FILE_NAMES,
  chatSession,
  replyToReport,
  takeBugDraft,
  takeUpdateRequest
} from '@oddboro/ledger';
import { reserveRun, releaseRun } from '@oddboro/ledger/run-registry';
import { firstQuestionIn, nextFirstQuestion } from '@oddboro/ledger/first-questions';
import type { ChatEntry, ChatEvent, ChatRef } from '#lib/staff/chat.ts';
import { isPicture, type ChatFile } from '#lib/attachments.ts';
import { splitChoices } from '#lib/choices.ts';
import { run, runHomeOf, type Run } from './staff.ts';
import { chatRun, show } from './run-state.ts';
import { addToChat, history, keepOwnerTurn, ChatInputError } from './chat-turns.ts';
import { attachedFiles, filesNow } from './chat-files.ts';
import { replyBrief, savedTaskWords } from './chat-delivery.ts';
import { missingChatSignIn } from './chat-sign-in.ts';
import { sessionIdIn } from './resume.ts';
import { changedSince, replay, replayed, replayedAt, replaySince } from './replay.ts';
import {
  chatPreface,
  fileLine,
  missedAt,
  type KeptFile,
  type RetoldEntry,
  type Session
} from './chat-preface.ts';
import { bus, emit } from './events.ts';
import { askShellToCheck, MANAGED } from './update.ts';

const CHAT_TIMEOUT_MS = 5 * 60_000;

export function activeReply(id: string) {
  const r = chatRun(id);
  return r?.turnId ? { runId: r.key, turnId: r.turnId } : undefined;
}

export async function stopReply(id: string, runId: string): Promise<boolean> {
  const r = chatRun(id);
  if (!r?.turnId || r.key !== runId) return false;
  r.stop.abort();
  await r.end.promise;
  return true;
}

/**
 * Send now: the owner's words go into the reply `runId` while it runs, and the
 * chat keeps them as an owner line of the same turn. Only a Claude Code chat
 * takes them (`add` on its run). False when that reply is gone, has given its
 * result, or cannot take words: the page then sends them as the next message.
 */
export function addToReply(id: string, runId: string, text: string): boolean {
  const r = chatRun(id);
  if (!r?.turnId || r.key !== runId || !r.add?.(text)) return false;
  addToChat(id, {
    at: new Date().toISOString(),
    from: 'owner',
    text,
    turnId: r.turnId,
    source: { kind: 'added' }
  });
  emit({ type: 'change', table: 'chat' });
  return true;
}

/** What the lead is told when the owner's message is about work it leads. */
export function aboutBrief(owner: ChatEntry): string[] {
  return owner.about
    ? [
        `The owner is speaking to you as lead of this ${owner.about.kind} #${owner.about.id}, "${owner.about.title}".`,
        'Apply their words to that work. This message does not stop a background job or approve an outside action.'
      ]
    : [];
}

function attachedBrief(files: (ChatFile & { path: string })[]): string {
  return [
    `({owner} attached ${files.length === 1 ? 'a file' : `${files.length} files`} to this message. Each is kept in your folder, and each tag in brackets in their message names one. Look at each picture and read each file before you answer. A picture already shown with this message needs no opening.`,
    ...files.map(fileLine),
    ')'
  ].join('\n');
}

export async function chat(
  id: string,
  message: string,
  onEvent: (e: ChatEvent) => void,
  replyTo?: Pick<ChatRef, 'kind' | 'id'>,
  files: (ChatFile & { path: string })[] = []
): Promise<void> {
  if (chatRun(id)) throw new Error(`${id} is already replying`);
  const turnId = randomUUID();
  await keepOwnerTurn(
    id,
    { turnId, message, source: { kind: 'chat' }, kept: files.map(({ path: _, ...f }) => f) },
    replyTo
  );
  return replyToOwnerTurn(id, turnId, onEvent);
}

export async function replyToOwnerTurn(
  id: string,
  turnId: string,
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  const log = history(id);
  const owner = log.find((e) => e.from === 'owner' && e.turnId === turnId);
  if (!owner) throw new ChatInputError('No saved message with that ID.');
  const answered = log.findLast(
    (e) => e.from === 'staff' && e.turnId === turnId && !e.failed && !e.interrupted
  );
  if (answered) {
    onEvent({
      type: 'done',
      text: answered.text,
      ...(answered.choices?.length ? { choices: answered.choices } : {}),
      ...(answered.bug ? { bug: answered.bug } : {}),
      ...(answered.updates ? { updates: true } : {})
    });
    return;
  }
  if (chatRun(id)) throw new Error('Another reply is in progress. Your message is saved.');
  // No await between checking and reserving: a second page sees this attempt.
  const live = reserveRun({ staffId: id, kind: 'chat', turnId });
  // A chat reply never goes through `slot`, so it tells the floor itself.
  show();
  const started = Date.now();
  // A retry carries what the owner added to the turn with Send now, too.
  const message = log
    .filter((e) => e.from === 'owner' && e.turnId === turnId)
    .map((e) => e.text)
    .join('\n\n');
  try {
    const who = await staffer(id);
    if (!who) throw new ChatInputError('No such Odd');
    const before = history(id).filter((e) => e.turnId !== turnId);
    const files = attachedFiles(id, owner.files);
    // The files as kept, which `tell_lead` takes to the lead.
    const attached = files.map(({ path: _, ...f }) => f);
    const replyTo = owner.re;
    const last = before.at(-1);
    const asked = last?.from === 'staff' ? firstQuestionIn(last.text) : -1;
    const next =
      !live.stop.signal.aborted &&
      owner.source?.kind === 'chat' &&
      !files.length &&
      !owner.re &&
      !owner.about
        ? nextFirstQuestion(asked, message)
        : undefined;
    if (next) {
      addToChat(id, {
        at: new Date().toISOString(),
        from: 'staff',
        text: next,
        told: true,
        turnId,
        runId: live.key
      });
      onEvent({ type: 'done', text: next });
      return;
    }
    onEvent({ type: 'reply', runId: live.key, turnId });
    let re: Awaited<ReturnType<typeof replyBrief>> | undefined;
    let r: Run;
    let usedTool = false;
    try {
      // Lines the office wrote in the chat, and work put on the desk, since the
      // owner last wrote are not in the session: say so, so an answer to the
      // hello, "How did the call go?" or "What about Thursday?" makes sense to
      // the staffer.
      re = replyTo ? await replyBrief(id, replyTo) : undefined;
      const landed = (await deliveries(id, 20)).filter(
        (d) => !(d.kind === re?.ref.kind && d.id === re.ref.id)
      );
      // Each owner line's files as they are now, for the lines the office retells below.
      const past: RetoldEntry[] = before.map((e) =>
        e.files?.length ? { ...e, now: filesNow(id, e.files) } : e
      );
      // A new session (the Odd moved to another tool, or its session is gone)
      // never saw the chat: it gets the latest of it word for word. The preface
      // leaves out the told, poke and failed run's owner lines the replay holds,
      // and keeps those the budget cut, so each line since the owner last wrote
      // is said once.
      const resumed = !!sessionIdIn(chatSession(id), await runHomeOf(who));
      const kept = resumed ? [] : replayed(past);
      const since = replaySince(past, kept);
      const session: Session = resumed ? 'resumed' : { replayed: new Set(replayedAt(past, kept)) };
      // A missed line's pictures go to the run as a new message's do. A line the
      // replay retells names its files by path alone, so a long replay never
      // sends every picture the chat ever held.
      const missed = missedAt(past, session).flatMap((i) => past[i].now ?? []);
      // The Odd writes only its own folder and the given folders it may change, so only those are walked.
      const writable = ownTools(who, currentPlatform())
        .granted.filter((f) => f.write)
        .map((f) => f.path);
      const prompt = [
        ...(since
          ? [
              replay(
                past,
                changedSince(
                  home('staff', id),
                  since,
                  OFFICE_FILE_NAMES.map((f) => join(home('staff', id), f)),
                  writable
                )
              )
            ]
          : []),
        ...chatPreface(past, landed, session),
        ...(re ? [re.brief] : []),
        ...(/\b(bug|bugs|issue tracker)\b/i.test(message)
          ? [
              '(For an Oddboro bug, draft the report with draft_bug_report: a short title and the details. The owner gets a File this bug report button under your reply, which opens the report form with your draft to review, and nothing is filed until they choose there. Tell them to click File this bug report.)'
            ]
          : []),
        ...aboutBrief(owner)
      ].join('\n\n');
      r = await run(who, prompt, {
        kind: 'chat',
        runId: live.key,
        ownerSaid: message,
        literal: [
          message,
          ...(files.length ? [attachedBrief(files).replaceAll('{owner}', await ownerName())] : []),
          ...(re?.taskResponse ? [savedTaskWords(re.taskResponse)] : [])
        ].join('\n\n'),
        chatBefore: past,
        ownerFiles: attached,
        images: [...files, ...missed].flatMap((f: KeptFile) =>
          'gone' in f || !isPicture(f.mediaType) ? [] : [{ path: f.path, mediaType: f.mediaType }]
        ),
        sessionFile: chatSession(id),
        timeoutMs: CHAT_TIMEOUT_MS,
        onEvent: (e) => {
          if (e.type === 'tool') usedTool = true;
          if (e.type !== 'done' && e.type !== 'error') onEvent(e);
        }
      });
    } catch (err) {
      r = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    // The bug report this run drafted, taken whatever the outcome: only a reply carries it.
    const bug = takeBugDraft(id, live.key);
    const update = takeUpdateRequest(id, live.key);
    const at = new Date();
    const common = {
      at: at.toISOString(),
      from: 'staff' as const,
      turnId,
      runId: live.key,
      took: at.getTime() - started
    };
    if (r.interrupted) {
      // Said apart from the owner's words, which sit just above it, so no quote ends in doubled punctuation.
      const text = 'You stopped this reply. Completed work and saved files remain.';
      addToChat(id, {
        ...common,
        text,
        interrupted: true,
        failed: true,
        ...(r.saved ? { inSession: true } : {})
      });
      onEvent({ type: 'done', text });
    } else if (r.ok) {
      const { text, choices } = splitChoices(r.text);
      const kept = {
        ...(choices.length ? { choices } : {}),
        ...(bug ? { bug } : {}),
        ...(update ? { updates: true as const } : {})
      };
      addToChat(id, { ...common, text, ...kept });
      onEvent({ type: 'done', text, ...kept });
      if (update?.check && MANAGED) askShellToCheck();
    } else {
      const signIn = usedTool
        ? undefined
        : await missingChatSignIn(who, r.text).catch(() => undefined);
      onEvent({ type: 'error', message: r.text, ...(signIn && { signIn }) });
      addToChat(id, {
        ...common,
        text: r.text,
        failed: true,
        ...(r.saved ? { inSession: true } : {})
      });
    }
    if (r.ok && re?.ref.kind === 'report') await replyToReport(re.ref.id, message);
  } finally {
    releaseRun(live);
    bus.emit('run-ended');
    show();
    emit({ type: 'change', table: 'chat' });
  }
}
