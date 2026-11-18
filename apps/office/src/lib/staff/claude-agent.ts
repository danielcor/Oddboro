import { parse } from 'yaml';
import { MODELS } from '@oddboro/ledger/agents';
import { LIMITS } from './roster.ts';

/**
 * An MCP server an agent file lists: by a name its owner gave it, by a web
 * address, or as a command it runs on the computer.
 */
export type ImportedServer = { name: string; url?: string; command?: string };

/** What the office does with each server a file lists (`sortServers`). */
export type SortedServers = {
  /** Each becomes an access ask at read when the Odd is hired. Nothing connects without a yes. */
  asks: { name: string; connector: string; label: string }[];
  /** Shown to the owner only. The office never runs or asks for these. */
  listed: { name: string; why: string }[];
};

/** At most this many servers are read from one file. */
export const MOST_SERVERS = 20;

/** The plain words for each setting the office leaves in the file. */
const SETTING_WORDS: Record<string, string> = {
  tools: 'its tool list',
  disallowedTools: 'its blocked tools',
  permissionMode: 'its permission mode',
  skills: 'its skills',
  model: 'its model',
  hooks: 'its hooks',
  memory: 'its memory',
  color: 'its colour',
  maxTurns: 'its turn limit',
  effort: 'its thinking level',
  background: 'its background setting',
  isolation: 'its isolation setting',
  initialPrompt: 'its first prompt'
};

/** The settings left in the file, in plain words: "its tool list, its skills". */
export const skippedSaid = (keys: string[]) =>
  keys.map((k) => SETTING_WORDS[k] ?? `its ${k} setting`).join(', ');

const BROKEN =
  "The agent file's header, between the --- lines, could not be read. Check it for a typo and try again.";

/** One entry of `mcpServers`, as a name or as `name: { url or command }`. */
function server(name: string, config: unknown): ImportedServer | undefined {
  const plain = name.trim().slice(0, 80);
  if (!plain) return undefined;
  if (!config || typeof config !== 'object') return { name: plain };
  const c = config as Record<string, unknown>;
  if (typeof c.command === 'string') return { name: plain, command: c.command.slice(0, 200) };
  if (typeof c.url === 'string') return { name: plain, url: c.url.trim().slice(0, 2000) };
  // Neither: the office cannot tell what it is, so it is only listed, like a command.
  return { name: plain, command: '' };
}

/** The servers in `mcpServers`: a list of names or one-key maps, or a map of name to settings. */
function serversIn(value: unknown): ImportedServer[] {
  const found: (ImportedServer | undefined)[] = [];
  if (Array.isArray(value))
    for (const item of value) {
      if (typeof item === 'string') found.push(server(item, undefined));
      else if (item && typeof item === 'object')
        for (const [k, v] of Object.entries(item)) found.push(server(k, v));
    }
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) found.push(server(k, v));
  return found.filter((s): s is ImportedServer => !!s).slice(0, MOST_SERVERS);
}

/** A name compared loosely, so "GitHub" and "github" are one. */
const loose = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** An https address, or nothing. */
function https(s: string): URL | undefined {
  if (!/^https:\/\/\S+$/.test(s)) return undefined;
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

/**
 * Which servers become access asks and which are only shown. A web address
 * (https) asks, and so does a name the office's tools already have. A command
 * is never run or asked for. The hire window and the office both sort with
 * this, each with the office's list of tools (`known`).
 */
export function sortServers(
  servers: ImportedServer[],
  known: { id: string; name: string }[]
): SortedServers {
  const sorted: SortedServers = { asks: [], listed: [] };
  const ask = (name: string, connector: string, label: string) => {
    if (!sorted.asks.some((a) => a.connector === connector))
      sorted.asks.push({ name, connector, label });
  };
  for (const s of servers.slice(0, MOST_SERVERS)) {
    if (s.command !== undefined) sorted.listed.push({ name: s.name, why: 'runs a command here' });
    else if (s.url !== undefined) {
      const url = https(s.url);
      if (url) ask(s.name, url.href, url.hostname);
      else sorted.listed.push({ name: s.name, why: 'not a secure web address' });
    } else {
      const k = loose(s.name);
      const match = known.find((c) => loose(c.id) === k || loose(c.name) === k);
      if (match) ask(s.name, match.id, match.name);
      else sorted.listed.push({ name: s.name, why: 'not one of the office tools' });
    }
  }
  return sorted;
}

export async function readClaudeAgentFile(file: File) {
  if (file.size > 256 * 1024) throw new Error('Choose an agent file smaller than 256 KB.');
  return readClaudeAgent(await file.text());
}

/** Read a Claude Code subagent file for the hire form. Only the owner grants tools. */
export function readClaudeAgent(file: string) {
  const source = file.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const parts = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!parts) throw new Error('Choose an agent Markdown file with a header between --- lines.');
  let header: unknown;
  try {
    header = parse(parts[1], { maxAliasCount: 0 });
  } catch {
    // The parser's own words name lines and columns, not what to do.
    throw new Error(BROKEN);
  }
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new Error('The agent header needs a name and a description.');
  const fields = header as Record<string, unknown>;
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!name || !description) throw new Error('The agent header needs a name and a description.');
  const instructions = source.slice(parts[0].length).trim();
  const desk = [description, instructions].filter(Boolean).join('\n\n');
  if (desk.length > LIMITS.desk)
    throw new Error(`Shorten the agent description and instructions to ${LIMITS.desk} characters.`);
  const model =
    MODELS.claude.find((m) => m.id === fields.model || m.id.startsWith(`claude-${fields.model}-`))
      ?.id ?? null;
  // Its servers come over as access asks or a list (`sortServers`), so they are not left behind.
  const imported = new Set(['name', 'description', 'mcpServers']);
  if (model || fields.model === 'inherit') imported.add('model');
  return {
    name: name.slice(0, LIMITS.name),
    role: name.replaceAll('-', ' ').slice(0, LIMITS.role),
    remit: description.slice(0, LIMITS.remit),
    desk,
    model,
    servers: serversIn(fields.mcpServers),
    skipped: Object.keys(fields).filter((key) => !imported.has(key))
  };
}
