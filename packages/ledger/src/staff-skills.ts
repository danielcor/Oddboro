// The instruction skills the owner attached to a local Odd: one SKILL.md each,
// by name. A run's prompt lists each name and description, and the Odd reads a
// skill's text with read_skill (mcp-skills.ts). A skill is text only and grants
// nothing. Only the owner changes them, from the Odd's info page.
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './db.ts';
import { record } from './office-ledger.ts';
import { staff, staffSkills } from './schema.ts';

/** One saved skill. */
export type Skill = { name: string; description: string; text: string };
/** What the owner saw of a saved skill: a change applies only while it is still so. */
export type SkillCopy = Pick<Skill, 'description' | 'text'>;

/** A local Odd's skills, by name. */
export async function skillsOf(staffId: string): Promise<Skill[]> {
  return db
    .select({
      name: staffSkills.name,
      description: staffSkills.description,
      text: staffSkills.text
    })
    .from(staffSkills)
    .where(eq(staffSkills.staffId, staffId))
    .orderBy(asc(staffSkills.name));
}

/**
 * Adds, replaces or removes (`next` null) the skill `name` of a local Odd that
 * still works here, only while the saved copy is still the one the owner
 * reviewed (`was`, null for none), so two open windows cannot both win.
 * Records each change in the ledger as the owner's. False when the copy
 * changed, or the Odd is gone or a persona.
 */
export async function setSkill(
  staffId: string,
  name: string,
  was: SkillCopy | null,
  next: SkillCopy | null
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [who] = await tx
      .select({ name: staff.name })
      .from(staff)
      .where(and(eq(staff.id, staffId), isNull(staff.leftAt), isNull(staff.package)));
    if (!who) return false;
    const row = and(eq(staffSkills.staffId, staffId), eq(staffSkills.name, name));
    const same = (copy: SkillCopy) =>
      and(row, eq(staffSkills.description, copy.description), eq(staffSkills.text, copy.text));
    let changed: { name: string }[] = [];
    if (!was && next)
      changed = await tx
        .insert(staffSkills)
        .values({ staffId, name, ...next })
        .onConflictDoNothing()
        .returning({ name: staffSkills.name });
    else if (was && next)
      changed = await tx
        .update(staffSkills)
        .set({ ...next, updatedAt: new Date() })
        .where(same(was))
        .returning({ name: staffSkills.name });
    else if (was)
      changed = await tx.delete(staffSkills).where(same(was)).returning({ name: staffSkills.name });
    else return false;
    if (!changed.length) return false;
    const done = !was ? 'Added' : next ? 'Updated' : 'Removed';
    await record(
      { kind: 'work', actor: 'owner', title: `${done} ${who.name}'s skill ${name}` },
      tx
    );
    return true;
  });
}
