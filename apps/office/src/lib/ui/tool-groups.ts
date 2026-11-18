// The Settings tab's two lists of office tools, after the owner's search: the
// ones the owner gives an Odd, and the ones every Odd always has. Both come
// from `OFFICE_TOOLS`, split by the ledger's own `isGrantable`, so a tool added
// there lands in one list or the other with no text written here.
import { isGrantable, isOffered, OFFICE_TOOLS } from '@oddboro/ledger/tools';

/** Whether what the owner typed is in any of `texts`, case ignored. An empty search finds everything. */
export const findsIn = (find: string, ...texts: string[]) => {
  const f = find.trim().toLowerCase();
  return !f || texts.some((t) => t.toLowerCase().includes(f));
};

/**
 * The office tools the search finds: `grantable` with a switch each, `alwaysOn`
 * with none. Always on keeps only the tools some run of this Odd is offered: a
 * chat holding Gmail, a service at Read and write, a shared project session
 * and a skill is the widest run, since the owner can give it all four and each of those
 * rows says it needs it, but no run makes the manager not the manager.
 */
export function toolGroups(find: string, odd: { manager?: boolean }) {
  const widest = {
    chat: true,
    gmail: true,
    write: true,
    project: true,
    skills: true,
    manager: odd.manager === true
  };
  const shown = OFFICE_TOOLS.filter((t) => findsIn(find, t.name, t.does));
  return {
    grantable: shown.filter((t) => isGrantable(t.id)),
    alwaysOn: shown.filter((t) => !isGrantable(t.id) && isOffered([], t.id, widest))
  };
}
