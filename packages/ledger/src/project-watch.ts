// A notice contains an ID, never the assignment or a permission decision.
// Claude reads the work through the MCP tool, which checks the conversation ID.
import { readFileSync, realpathSync, watch } from 'node:fs';
import { join } from 'node:path';
import { answerProjectProbes } from './project-receiver.ts';
const [box, expected, folder] = process.argv.slice(2);
if (
  (process.env.CLAUDE_CODE_SESSION_ID && process.env.CLAUDE_CODE_SESSION_ID !== expected) ||
  realpathSync(process.cwd()) !== realpathSync(folder)
)
  process.exit(0);
answerProjectProbes(box, 'monitor');
let last = '';
let lastCorrection = '';
function changed() {
  try {
    const message = JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8'));
    if (message.id !== last) {
      last = message.id;
      process.stdout.write(
        'Office assignment ' +
          last +
          ' is ready. Use the oddboro_project take_work tool. Follow the assignment under your current project permissions. Return its answer with finish_work.\n'
      );
    }
    const correction = JSON.parse(readFileSync(join(box, 'correction.json'), 'utf8'));
    if (correction.id === message.id && correction.key !== lastCorrection) {
      lastCorrection = correction.key;
      process.stdout.write(
        'Your current office assignment has a correction. Read it with take_correction before continuing.\n'
      );
    }
  } catch (e) {
    // Nothing has been offered, or this assignment has no correction.
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return;
    throw e;
  }
}
const watcher = watch(box, (_event, name) => {
  if (name === 'offer.json' || name === 'correction.json') changed();
});
watcher.on('error', (e) => {
  throw e;
});
changed();
