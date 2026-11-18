// BERT's uncased WordPiece tokenizer, which Nomic Embed Text uses, written out
// so the office needs no tokenizer library. It reads the model's own vocab.txt
// and turns text into token ids the way Hugging Face's BertTokenizer does:
// clean the text, space out Chinese characters, take accents off, lower the
// case, split on spaces and punctuation, then match each word to the longest
// pieces in the vocabulary.

const CLS = '[CLS]';
const SEP = '[SEP]';
const UNK = '[UNK]';
/** A word longer than this is one unknown token, as BERT has it. */
const LONGEST_WORD = 100;

const CONTROL = /\p{C}/u;
const SPACE = /[\t\n\r]|\p{White_Space}/u;
const PUNCTUATION = /[!-/:-@[-`{-~]|\p{P}/u;
const ACCENT = /\p{Mn}/gu;

/** The ideographs BERT spaces apart, so each is a word of its own. */
function chinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/** The text's words and punctuation marks, cleaned, lower case and without accents. */
export function basicTokens(text: string): string[] {
  let clean = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (SPACE.test(ch)) clean += ' ';
    else if (cp === 0 || cp === 0xfffd || CONTROL.test(ch)) continue;
    else if (chinese(cp)) clean += ` ${ch} `;
    else clean += ch;
  }
  const words: string[] = [];
  for (const word of clean.normalize('NFD').replace(ACCENT, '').toLowerCase().split(' ')) {
    let run = '';
    for (const ch of word) {
      if (PUNCTUATION.test(ch)) {
        if (run) words.push(run);
        words.push(ch);
        run = '';
      } else run += ch;
    }
    if (run) words.push(run);
  }
  return words;
}

export type Tokenizer = {
  /** `[CLS]`, the text's pieces up to `max` in all, then `[SEP]`. */
  encode(text: string, max: number): number[];
};

/** A tokenizer over a vocab.txt: one piece a line, its id the line's number from 0. */
export function wordpiece(vocabText: string): Tokenizer {
  const vocab = new Map<string, number>();
  vocabText.split('\n').forEach((piece, id) => {
    const p = piece.replace(/\r$/, '');
    if (p && !vocab.has(p)) vocab.set(p, id);
  });
  const id = (piece: string) => {
    const n = vocab.get(piece);
    if (n === undefined) throw new Error(`The vocabulary has no ${piece}`);
    return n;
  };
  const cls = id(CLS);
  const sep = id(SEP);
  const unk = id(UNK);

  function pieces(word: string, out: number[]): void {
    const chars = [...word];
    if (chars.length > LONGEST_WORD) {
      out.push(unk);
      return;
    }
    const found: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let match: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        match = vocab.get(piece);
        if (match !== undefined) break;
        end--;
      }
      if (match === undefined) {
        out.push(unk);
        return;
      }
      found.push(match);
      start = end;
    }
    out.push(...found);
  }

  return {
    encode(text, max) {
      const ids = [cls];
      for (const word of basicTokens(text)) {
        pieces(word, ids);
        if (ids.length >= max - 1) break;
      }
      ids.length = Math.min(ids.length, max - 1);
      ids.push(sep);
      return ids;
    }
  };
}
