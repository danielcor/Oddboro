// The owner attaches the text of a SKILL.md to an Odd, as many as they like,
// each by name. Its front matter (YAML between `---` lines at the top) gives
// the name and when to use it. A run gets no extra tools or files from it.
// Safe in the browser.
const SKILL_BYTES = 32 * 1024;
/** The longest name, as Claude Code's own skills allow. */
export const NAME_CHARS = 64;
/** The longest description, kept short since every run's prompt carries it. */
export const DESCRIPTION_CHARS = 500;

/** What a SKILL.md's front matter says, where it says it. */
export type FrontMatter = {
  name?: string;
  description?: string;
  /** Whether it lists tools it wants (`allowed-tools`), which an Odd never gets from it. */
  asksForTools: boolean;
};

/** A YAML value as plain text: quotes off, a block's or a list's lines joined. */
function plainValue(first: string, more: string[]): string {
  const parts = /^[>|][+-]?$/.test(first) ? more : [first, ...more];
  const joined = parts
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  const quoted = /^(['"])(.*)\1$/.exec(joined);
  return (quoted ? quoted[2] : joined).trim();
}

/**
 * The keys a SKILL.md's front matter gives that the office uses. Each is read
 * as `key: value`, a quoted value, a folded or literal block, or a list. A
 * file with no front matter gives nothing.
 */
export function frontMatter(text: string): FrontMatter {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const end =
    lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l)) : -1;
  const keys = new Map<string, string>();
  let key: string | undefined;
  let first = '';
  let more: string[] = [];
  const keep = () => {
    if (key) keys.set(key, plainValue(first, more));
  };
  for (const line of lines.slice(1, Math.max(end, 1))) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      keep();
      key = top[1].toLowerCase();
      first = top[2].trim();
      more = [];
    } else if (key) more.push(line.replace(/^\s*-\s+/, ''));
  }
  keep();
  const name = keys.get('name');
  const description = keys.get('description');
  return {
    ...(name && { name }),
    ...(description && { description }),
    asksForTools: !!keys.get('allowed-tools')
  };
}

/** Whether a SKILL.md points at other files, such as scripts or references, which never come with it. */
export function mentionsFiles(text: string): boolean {
  const linked = /\]\((?!https?:|mailto:|#)[^)\s]+\)/.test(text);
  const path = /(^|[\s`'"(])[\w.-]+\/[\w./-]*\w\.\w{1,5}\b/.test(text);
  const file = /(^|[\s`'"(])(?!SKILL\.md)[\w-]+\.(md|py|sh|json|txt|ya?ml|csv)\b/.test(text);
  return linked || path || file;
}

/** One line: each run of spaces and line breaks as one space. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function skillSizeProblem(bytes: number): string | undefined {
  if (bytes > SKILL_BYTES) return `Choose a SKILL.md of ${SKILL_BYTES / 1024} KB or less.`;
  return undefined;
}

export function skillProblem(text: string): string | undefined {
  if (!text.trim()) return 'Choose a skill that contains instructions.';
  if (text.includes('\0')) return 'Save the skill as UTF-8 text.';
  return skillSizeProblem(new TextEncoder().encode(text).length);
}

export function nameProblem(name: string): string | undefined {
  if (!name) return 'Give the skill a name.';
  if (name.length > NAME_CHARS) return `Keep the name to ${NAME_CHARS} characters or less.`;
  if (!/^\w[\w .-]*$/.test(name))
    return 'Use only letters, numbers, spaces, dots, dashes and underscores in the name.';
  return undefined;
}

export function descriptionProblem(description: string): string | undefined {
  if (!description) return 'Say in one line when to use this skill.';
  if (description.length > DESCRIPTION_CHARS)
    return `Keep when to use it to ${DESCRIPTION_CHARS} characters or less.`;
  return undefined;
}
