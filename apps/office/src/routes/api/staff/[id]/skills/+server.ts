// A local Odd's skills: the list, and the owner's change to one by name. A
// change applies only while the saved copy is the one the owner reviewed
// (`was`), so two open windows cannot both win.
import { error, json } from '@sveltejs/kit';
import { setSkill, skillsOf, staffer, type SkillCopy } from '@oddboro/ledger';
import { descriptionProblem, nameProblem, oneLine, skillProblem } from '#lib/staff/skill.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const who = await staffer(params.id);
  if (!who || who.package) error(404, 'No such local Odd.');
  return json({ skills: await skillsOf(who.id) });
};

/** A skill copy from the page, null for none, or undefined when it is neither. */
function copyOf(v: unknown): SkillCopy | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object') return undefined;
  const { description, text } = v as Record<string, unknown>;
  return typeof description === 'string' && typeof text === 'string'
    ? { description, text }
    : undefined;
}

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => null);
  const was = copyOf(body?.was);
  const next = copyOf(body?.skill);
  if (typeof body?.name !== 'string' || was === undefined || next === undefined)
    error(400, 'Choose a skill first.');
  const name = oneLine(body.name);
  const problem = nameProblem(name);
  if (problem) error(400, problem);
  if (next) {
    next.description = oneLine(next.description);
    const wrong = descriptionProblem(next.description) ?? skillProblem(next.text);
    if (wrong) error(400, wrong);
  }
  if (!(await setSkill(params.id, name, was, next)))
    error(409, 'This skill changed in another window. Open the Skills tab again.');
  return json({ ok: true });
};
