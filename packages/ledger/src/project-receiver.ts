// A fresh probe proves the paired tool server and monitor are both running.
// A file left by an earlier process is never proof that this session can listen.
import { readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const PROJECT_RECEIVERS = ['tools', 'monitor'] as const;
const probe = z.object({ key: z.string().uuid() });

export function answerProjectProbes(box: string, receiver: (typeof PROJECT_RECEIVERS)[number]) {
  const answer = () => {
    try {
      const { key } = probe.parse(JSON.parse(readFileSync(join(box, 'probe.json'), 'utf8')));
      writeFileSync(join(box, key + '.' + receiver), '', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      // No probe yet, or a repeated filesystem notice for the same probe.
      if (e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'EEXIST')) return;
      throw e;
    }
  };
  const watcher = watch(box, (_event, name) => {
    if (name === 'probe.json') answer();
  });
  watcher.on('error', (e) => {
    throw e;
  });
  answer();
  return watcher;
}
