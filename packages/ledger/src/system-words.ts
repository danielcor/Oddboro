// The words for the owner's computer in what the office says, on each
// system. Imports only a type, so the page can read it too.
import type { System } from './platform.ts';

/** What the office says where the words differ by system. */
export type SystemWords = {
  /** The computer's own word: "Mac", or "computer". */
  word: 'Mac' | 'computer';
  /** The computer as a label: "Your Mac", or "This computer". */
  label: string;
  /** How the system asks before it trusts the office's certificate (Make it secure). */
  trustAsks: string;
  /** Make it secure's button while the system asks. */
  trustWaiting: string;
  /** What Make it secure says when the system did not trust the certificate. */
  trustFailed: (typeof TRUST_FAILED)[keyof typeof TRUST_FAILED];
  /** Browsers to use instead of Firefox, which keeps its own list of trusted certificates. */
  notFirefox: string;
};

/**
 * The words for a failed Make it secure, one per way a system asks. Each keeps
 * its literal type, so the office throws it as a `fixedError`, whose message
 * an error report may keep.
 */
const TRUST_FAILED = {
  password: 'The certificate was not trusted. Try again, and enter your password.',
  confirm: 'The certificate was not trusted. Try again, and confirm when Windows asks.'
} as const;

/** Linux's, and a system the office does not know, or not yet. */
const COMPUTER: SystemWords = {
  word: 'computer',
  label: 'This computer',
  trustAsks: "It takes your computer's password, once.",
  trustWaiting: 'Waiting for your password',
  trustFailed: TRUST_FAILED.password,
  notFirefox: 'Chrome or Edge'
};

const WORDS: Record<System, SystemWords> = {
  mac: {
    word: 'Mac',
    label: 'Your Mac',
    trustAsks: "It takes your Mac's password, once.",
    trustWaiting: 'Waiting for your password',
    trustFailed: TRUST_FAILED.password,
    notFirefox: 'Safari or Chrome'
  },
  linux: COMPUTER,
  // Windows adds the certificate to the owner's own list after its dialog asks, with no password.
  windows: {
    ...COMPUTER,
    trustAsks: 'Windows asks you to confirm it, once.',
    trustWaiting: 'Waiting for you to confirm',
    trustFailed: TRUST_FAILED.confirm
  }
};

/** The words on `system`; on a system the office does not know, or not yet, a computer's. */
export function systemWords(system: System | undefined): SystemWords {
  return system ? WORDS[system] : COMPUTER;
}

/** "Mac" on a Mac; anywhere else, or when the system is not known yet, "computer". */
export function computerWord(system: System | undefined): 'Mac' | 'computer' {
  return systemWords(system).word;
}
