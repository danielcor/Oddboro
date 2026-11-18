// Work a lead parked until a task on the owner's desk ends. The task's end is
// the only wake: nothing looks at the clock or goes round a loop for it.
import { db } from './db.ts';
import { fixedError } from './errors.ts';
import { worksOnIds } from './threads.ts';
import { transitionWork } from './work/apply.ts';

/**
 * Parks work on a task through the work core (`parked`), or says why it
 * cannot. The task is locked with the park, so it cannot end between the
 * look and the park and leave the work waiting on a task already over.
 */
export async function parkOnTask(
  hubId: string,
  id: number,
  taskId: number
): Promise<{ title: string } | { problem: string }> {
  const parked = await transitionWork({
    kind: 'parked',
    staffId: hubId,
    threadId: id,
    on: { task: taskId },
    worksOn: await worksOnIds(db, hubId)
  });
  if ('refused' in parked) return { problem: parked.refused };
  const r = parked.change.result;
  if (!('title' in r)) throw fixedError('A park on a task came back as a park on a time.');
  return r;
}

/**
 * How a task ended, as the work parked on it hears it: `withdrawn` is the
 * office or its Odd taking it off the desk (`withdrawTask`, or `oddRemoved` as its
 * Odd left), never the owner's drop.
 */
export type TaskEnded = 'done' | 'dropped' | 'withdrawn';
