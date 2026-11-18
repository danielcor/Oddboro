// The lead of a piece of work picks it up with a line, as an owner's answer
// with no run of its own brings it back: the production step (`answerLead`),
// through the work core's loader and writer, so a test drives the same code
// every answer does. Import it with `await import()` after `./pglite.ts`,
// since it loads db.ts.
import { transition } from '../src/transition.ts';
import { applyWork } from '../src/work/apply.ts';
import { answerLead } from '../src/work/answers.ts';
import { loadWork } from '../src/work/load.ts';
import { changeOf, draft } from '../src/work/snapshot.ts';

export async function answerLeadNow(threadId: number, line: string): Promise<void> {
  await transition({
    name: 'answerLead',
    // A park on a time names only the work, so it loads and locks the work,
    // its lead and every run on it: all `answerLead` reads.
    load: (tx) =>
      loadWork(tx, {
        kind: 'parked',
        staffId: '',
        threadId,
        on: { at: new Date() },
        worksOn: new Set()
      }),
    decide: (rows, now) => {
      const d = draft(rows);
      answerLead(d, threadId, line, {}, now);
      return { change: changeOf(d, null), after: [] };
    },
    apply: async (tx, change) => {
      await applyWork(tx, change);
    }
  });
}
