// The office's own MCP server: how a staffer reaches the ledger, raises an
// ask, gives the owner a task and finds tools. The office app starts one per staff
// run with STAFF_ID set, so a staffer only ever acts as itself. It offers only
// the tools the owner granted that staffer (tools.ts), so the rest do not exist.
//
//   node packages/ledger/src/mcp.ts      (stdio; the office starts it)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './mcp-run.ts';
import './mcp-people.ts';
import './mcp-updates.ts';
import './mcp-skills.ts';

await server.connect(new StdioServerTransport());
// The database pool would keep the process alive after Claude Code hangs up.
process.stdin.on('end', () => process.exit(0));
