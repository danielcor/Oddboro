import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
// Every project action, from the owner's Projects work area. All of them
// refuse while Advanced mode is off.
import {
  advancedMode,
  connection,
  letSendUnasked,
  projectOverview,
  projectWork,
  requestProject,
  shareProject,
  changeProjectRequest
} from '@oddboro/ledger';
import { ADVANCED_OFF, projectController } from '#lib/server/project-sessions/controller.ts';
import type { RequestHandler } from './$types';
const id = z.string().uuid(),
  agent = z.enum(['codex', 'claude']),
  folder = z.string().min(1).max(4096);
const socket = z.string().min(1).max(4096).optional();
const file = z.string().min(1).max(4096).optional();
const prompt = z.string().trim().min(1).max(64000);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('connections') }),
  z.object({ action: z.literal('find'), agent, folder, socket }),
  z.object({
    action: z.literal('connect'),
    agent,
    folder,
    socket,
    nativeId: id.optional(),
    title: z.string().max(200).optional(),
    handedOver: z.boolean().optional()
  }),
  z.object({ action: z.literal('history'), id }),
  z.object({ action: z.literal('send'), id, key: id, prompt, file }),
  z.object({ action: z.literal('share'), id, staffId: z.string().min(1).max(100).nullable() }),
  z.object({ action: z.literal('unasked'), id, staffId: z.string().min(1).max(100).nullable() }),
  z.object({ action: z.literal('decide'), id, key: id, approve: z.boolean() }),
  z.object({ action: z.literal('resolve'), id, key: id }),
  z.object({ action: z.literal('terminal'), id }),
  z.object({ action: z.literal('control'), id, view: id }),
  z.object({ action: z.literal('keys'), id, view: id, data: z.string().max(100000) }),
  z.object({
    action: z.literal('size'),
    id,
    view: id,
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(200)
  }),
  z.object({ action: z.literal('steer'), id, turn: z.string(), prompt, file }),
  z.object({ action: z.literal('stop'), id, expected: z.string() }),
  z.object({
    action: z.literal('answer'),
    id,
    key: id,
    request: z.union([z.string(), z.number()]),
    pick: z.enum(['accept', 'decline']),
    answers: z.record(z.string(), z.array(z.string())).optional()
  }),
  z.object({ action: z.literal('disconnect'), id })
]);
export const POST: RequestHandler = async ({ request }) => {
  if (!(await advancedMode())) error(403, ADVANCED_OFF);
  const data = command.safeParse(await request.json().catch(() => null));
  if (!data.success) error(400, 'Invalid project session request.');
  const a = data.data,
    c = projectController();
  try {
    switch (a.action) {
      case 'connections':
        return json(
          (await projectOverview()).map((s) => ({
            ...s,
            status: c.status(s.id, s.status),
            connected: c.view(s.id).connected
          }))
        );
      case 'find':
        return json(await c.list(a.agent, a.folder, a.socket));
      case 'connect':
        return json(
          await c.connect(a.agent, a.folder, a.nativeId, a.title, a.handedOver, a.socket)
        );
      case 'history':
        return json({
          session: await connection(a.id),
          work: await projectWork(a.id),
          view: c.view(a.id)
        });
      case 'send':
        await c.checkInput(a.id, a.prompt, a.file);
        await requestProject({ id: a.key, sessionId: a.id, prompt: a.prompt, file: a.file });
        await c.work(a.id);
        break;
      case 'share':
        await shareProject(a.id, a.staffId);
        break;
      case 'unasked':
        await letSendUnasked(a.id, a.staffId);
        break;
      case 'decide':
        if (
          !(await changeProjectRequest(
            a.key,
            a.id,
            ['proposed', 'failed'],
            a.approve ? 'authorized' : 'stopped',
            { answer: '' }
          ))
        )
          throw new Error('That proposal is no longer waiting.');
        if (a.approve) await c.work(a.id);
        break;
      case 'resolve':
        await c.resolve(a.id, a.key);
        break;
      case 'terminal':
        await c.terminal(a.id);
        break;
      case 'control':
        c.openTerminal(a.id).take(a.view, true);
        break;
      case 'keys':
        c.openTerminal(a.id).requireControl(a.view).write(a.data);
        break;
      case 'size':
        c.openTerminal(a.id).requireControl(a.view).resize(a.cols, a.rows);
        break;
      case 'steer':
        await c.steer(a.id, a.turn, a.prompt, a.file);
        break;
      case 'stop':
        await c.stop(a.id, a.expected);
        break;
      case 'answer':
        await c.answer(a.id, a.request, a.key, a.pick, a.answers);
        break;
      case 'disconnect':
        await c.disconnect(a.id);
        break;
    }
    return json({ ok: true });
  } catch (e) {
    error(
      409,
      e instanceof Error ? e.message : 'The project session could not complete that action.'
    );
  }
};
