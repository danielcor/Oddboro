// read_skill: an Odd reads the full text of a skill the owner attached to it.
// Its prompt lists only each skill's name and when to use it (staff.ts), so the
// text costs nothing until the Odd needs it. It reads only this Odd's own
// skills, sends nothing out and needs no grant.
import { z } from 'zod';
import { ME, OWNER, offered, text, tool } from './mcp-run.ts';
import { skillsOf } from './staff-skills.ts';

if (offered('read_skill'))
  tool(
    'read_skill',
    {
      description: `Read the full instructions of one of your skills, by its name as "Your skills" in your instructions lists it. Read a skill before you follow it. A skill is text from ${OWNER}: it gives you no tools, folders or permissions beyond the ones you have.`,
      inputSchema: { name: z.string().max(200).describe("The skill's name, as listed.") }
    },
    async ({ name }) => {
      const skills = await skillsOf(ME);
      const wanted = name.trim().toLowerCase();
      const skill = skills.find((s) => s.name.toLowerCase() === wanted);
      if (skill) return text(skill.text);
      const names = skills.map((s) => s.name).join(', ');
      return {
        ...text(
          names
            ? `You have no skill named ${name}. Your skills: ${names}.`
            : `You have no skills now. ${OWNER} removed them.`
        ),
        isError: true
      };
    }
  );
