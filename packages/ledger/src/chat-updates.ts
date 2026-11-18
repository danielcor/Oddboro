// A chat can request a check and show the updater's owner controls. It can
// never install: that stays with the owner's existing Updates buttons.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { home, OFFICE_FILES } from './home.ts';

/** The office's status at the start of this chat, without release-note text. */
export const chatUpdateStatus = z.object({
  current: z.string(),
  managed: z.boolean(),
  ready: z.boolean(),
  version: z.string().nullable(),
  installAt: z.string().nullable(),
  checking: z.boolean(),
  checked: z
    .object({
      at: z.string(),
      result: z.enum(['none', 'ready', 'failed']),
      problem: z.string().optional()
    })
    .nullable()
});
export type ChatUpdateStatus = z.infer<typeof chatUpdateStatus>;
const request = z.object({ run: z.string(), check: z.boolean() }).strict();
const requestFile = (staffId: string) => home('staff', staffId, OFFICE_FILES.updateRequest);

export function keepUpdateRequest(staffId: string, value: z.infer<typeof request>): void {
  const earlier = takeUpdateRequest(staffId, value.run);
  mkdirSync(home('staff', staffId), { recursive: true });
  writeFileSync(
    requestFile(staffId),
    JSON.stringify({ ...value, check: value.check || !!earlier?.check })
  );
}

/** Consume it on every outcome, so a failed or stopped run leaves nothing to replay. */
export function takeUpdateRequest(staffId: string, run: string) {
  const file = requestFile(staffId);
  if (!existsSync(file)) return;
  try {
    const kept = request.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (kept.success && kept.data.run === run) return { check: kept.data.check };
  } catch {
    // An unreadable or damaged request cannot authorize even a check.
  } finally {
    rmSync(file, { force: true });
  }
}
