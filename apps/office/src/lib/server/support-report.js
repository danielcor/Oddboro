// Used by Setup and, with the bundled Node, the desktop startup error dialog.
// Only recognized events are printable. Never copy a raw error into a report.
import { open } from 'node:fs/promises';

const LIMIT = 128 * 1024;
const timestamp = /^(?:oddboro: )?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) /;
const step = /^office: (key|secrets|database|tables|update row) in (\d{1,9}) ms$/;
const setup =
  /^office: setup (node|claude|database|keychain|keyring|git|ollama|uv|service|address|login|pgvector) (ok|fail)$/;

/** @param {string} line */
function event(line) {
  const timed = line.match(timestamp);
  const text = line.slice(timed?.[0].length ?? 0);
  let name;
  if (
    step.test(text) ||
    setup.test(text) ||
    /^office: ready \d{1,9} ms after Node started$/.test(text)
  )
    name = text.slice(8);
  else if (/^started node, pid \d+$/.test(text)) name = 'Started office server';
  else if (text.startsWith('node stopped:')) name = 'Office server stopped';
  else if (text.startsWith('update check failed')) name = 'Update check failed';
  else if (text === 'update check: this is the newest version') name = 'App version is current';
  else if (/^restarting node in \d+s$/.test(text)) name = 'Restarting office server';
  else if (/^office: (key|secrets|database|tables|update row) failed$/.test(text))
    name = text.slice(8);
  return name && (timed ? timed[1] + ' ' + name : name);
}

/** @param {string} file @param {string} version */
export async function supportReport(file, version) {
  const app = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : 'development';
  const lines = [
    'Oddboro support report',
    'Version: ' + app,
    'System: ' + process.platform + ' ' + process.arch,
    'Saved: ' + new Date().toISOString(),
    'Recent office log:'
  ];
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - LIMIT);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const entries = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/);
    entries.pop(); // Only finished lines.
    if (start) {
      entries.shift();
      lines.push('Earlier log entries omitted.');
    }
    const recognized = entries.map(event).filter((line) => line !== undefined);
    lines.push(...recognized.slice(-100));
    lines.push('Entries omitted: ' + (entries.length - Math.min(recognized.length, 100)));
  } catch {
    lines.push('Office log unavailable.');
  } finally {
    await handle?.close();
  }
  return lines.join('\n') + '\n';
}
