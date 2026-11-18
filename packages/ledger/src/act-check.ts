// The Act check: three true or false statements the owner answers once before
// they put any Odd at Act for the first time. The words, the right answers and
// what each wrong answer is told live here and nowhere else. The page shows
// the statements and posts the owner's answers; the office checks them
// (`passActCheck` in office-staff.ts) and records the pass. No Odd's prompt or
// tool reads this file.

export type ActCheckItem = {
  /** The statement the owner marks True or False. */
  says: string;
  /** Whether the statement is true. */
  answer: boolean;
  /** What shows under it when the owner picked the other answer. */
  ifWrong: string;
};

export const ACT_CHECK_TITLE = 'Before you put an Odd at Act';
export const ACT_CHECK_LEAD = "Answer these three once. Pass, and you won't see this again.";

export const ACT_CHECK: readonly ActCheckItem[] = [
  {
    says: 'At Act, an Odd can send emails, post messages and change things in the tools you connected for it, without asking you first.',
    answer: true,
    ifWrong:
      'It is true: at Act an Odd uses its write tools without asking. At Draft each change waits for your yes.'
  },
  {
    says: 'Something an Odd reads, like an email or a web page, could trick it into sending your information somewhere. At Act, it would not stop to ask you first.',
    answer: true,
    ifWrong:
      'It is true: an Odd can be tricked by what it reads, and at Act nothing stops to ask you.'
  },
  {
    says: "Once an Odd is at Act, you can't move it back to Draft.",
    answer: false,
    ifWrong: "It is false: you can lower an Odd's level any time in its Settings tab."
  }
];

/** What the office says when something would put an Odd at Act before the check is passed. */
export const ACT_CHECK_NEEDED =
  'Pass the Act check first: three questions before you put an Odd at Act.';

/**
 * Which of the owner's answers are wrong, by position, or undefined when
 * `answers` is not one true or false for each statement.
 */
export function wrongAnswers(answers: unknown): number[] | undefined {
  if (
    !Array.isArray(answers) ||
    answers.length !== ACT_CHECK.length ||
    !answers.every((a) => typeof a === 'boolean')
  )
    return undefined;
  return ACT_CHECK.flatMap((item, i) => (answers[i] === item.answer ? [] : [i]));
}
