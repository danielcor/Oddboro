// The paired native Claude session can read only its one assignment and hand
// back its result. It receives neither database access nor an office HTTP token.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  realpathSync
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { answerProjectProbes } from './project-receiver.ts';
const [box, nativeId, cwd] = process.argv.slice(2);
const server = new McpServer({ name: 'oddboro_project', version: '1.0.0' });
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const isPaired = () =>
  process.env.CLAUDE_CODE_SESSION_ID === nativeId &&
  realpathSync(process.cwd()) === realpathSync(cwd);
function paired() {
  if (!isPaired()) throw new Error('This conversation is not paired with that office project.');
}
function offer() {
  paired();
  const row = JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8')) as {
    id: string;
    prompt: string;
  };
  if (!/^[0-9a-f-]{36}$/i.test(row.id)) throw new Error('The office offer is invalid.');
  return row;
}
// Publish only a complete record. A duplicate delivery leaves the first one intact.
function publish(name: string, data: unknown) {
  const temp = join(box, randomUUID() + '.tmp');
  writeFileSync(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, join(box, name));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkSync(temp);
  }
}
server.registerTool(
  'take_work',
  {
    description:
      'Read the new office assignment for this conversation. Return its answer with finish_work.',
    inputSchema: {}
  },
  () => {
    const row = offer();
    return text(
      publish(row.id + '.accepted', {})
        ? JSON.stringify(row)
        : 'This assignment was already accepted. Continue the existing work.'
    );
  }
);
server.registerTool(
  'take_correction',
  { description: 'Read the latest correction to the current office assignment.', inputSchema: {} },
  () => {
    const row = offer(),
      correction = JSON.parse(readFileSync(join(box, 'correction.json'), 'utf8'));
    if (correction.id !== row.id || !/^[0-9a-f-]{36}$/i.test(correction.key))
      throw new Error('No correction for this assignment.');
    publish(correction.key + '.correction-read', { id: row.id });
    return text(correction.prompt);
  }
);
server.registerTool(
  'finish_work',
  {
    description:
      'Return the answer and any project-relative file references to the office that assigned the work.',
    inputSchema: { id: z.string().uuid(), answer: z.string().min(1).max(100000) }
  },
  ({ id, answer }) => {
    if (offer().id !== id) throw new Error('This is no longer the current assignment.');
    const file = join(box, 'correction.json');
    if (existsSync(file)) {
      const correction = JSON.parse(readFileSync(file, 'utf8'));
      if (correction.id === id && !existsSync(join(box, correction.key + '.correction-read')))
        throw new Error(
          'Read the owner’s pending correction with take_correction before finishing.'
        );
    }
    publish(id + '.reply', { answer });
    return text('The office has your answer.');
  }
);
await server.connect(new StdioServerTransport());
// Another conversation in this project loads the plugin too. Its tools stay
// up and refuse, and it never answers the office's readiness check.
if (isPaired()) {
  const receiver = answerProjectProbes(box, 'tools');
  server.server.onclose = () => receiver.close();
}
