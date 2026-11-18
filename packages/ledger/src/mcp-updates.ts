import { z } from 'zod';
import { chatUpdateStatus, keepUpdateRequest } from './chat-updates.ts';
import { ME, RUN_KEY, OWNER, offered, tool, json, refused } from './mcp-run.ts';

if (offered('oddboro_update'))
  tool(
    'oddboro_update',
    {
      description: `Read Oddboro's installed version and update status, and show its live Updates controls below your reply. Use check when ${OWNER} asks to check for a new version; the check starts after your reply and its result appears in the controls. The returned status is from the start of this chat run, not the result of that new check. Use status for the current known state or when asked to install. To install, tell ${OWNER} to click Install now below your reply, which approves installation and restart. This tool never installs, restarts or changes the update window. No downloaded update is not proof this is the newest version; read the last check's result and time.`,
      inputSchema: { action: z.enum(['status', 'check']) }
    },
    ({ action }) => {
      if (!RUN_KEY) return refused('This run has no reply to put the update controls on.');
      let status;
      try {
        status = chatUpdateStatus.parse(JSON.parse(process.env.ODDBORO_UPDATE_STATUS ?? 'null'));
      } catch {
        return refused('The office did not supply its update status for this run.');
      }
      const check = action === 'check' && status.managed && !status.ready && !status.checking;
      keepUpdateRequest(ME, { run: RUN_KEY, check });
      return json({
        ...status,
        checkRequested: check,
        controls:
          'Updates appear below this reply. Install now is the owner’s approval to install and restart.'
      });
    }
  );
