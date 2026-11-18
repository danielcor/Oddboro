# Contributing

Thanks for helping. Oddboro is licensed Apache-2.0 (`LICENSE`), and
anything you contribute comes in under that license.

## Sign off every commit

Every commit in a pull request carries a sign-off under the
[Developer Certificate of Origin](https://developercertificate.org/). It says
you wrote the change, or have the right to submit it, under the project's
license.

1. Make sure git knows your real name and email:
   `git config user.name` and `git config user.email`.
2. Commit with `-s`: `git commit -s -m "Fix the chair clash"`.
3. Check the commit ends with a line like
   `Signed-off-by: Your Name <you@example.com>`.

Forgot one? `git commit --amend -s` fixes the last commit, and
`git rebase --signoff main` fixes every commit on your branch.

## Before you open a pull request

1. Create `data/private-words.txt` once: one word per line, with your names
   and account names. Git ignores `data/`, and `npm run lint` fails until the
   file exists, so none of those words slips into a commit.
2. Run the three checks from the repo root. Each must report zero problems.

   ```sh
   npm run lint
   npm run check-types
   npm run format:check
   ```

The rules behind them are in `CLAUDE.md`.

## When we ask you something

1. A maintainer who needs something from you comments on the pull request
   and labels it `waiting-on-author`.
2. Reply or push a commit. Either one moves it back to `needs-review` by
   itself.
3. With no reply for 7 days, a bot labels it `stale` and reminds you.
4. With no reply for 7 more days, the bot closes it. Reopen it whenever you
   are ready, and we pick it up again.

A pull request labelled `keep-open` is never closed by the bot. Our comment
on it says what happens if we do not hear back.

## The name

The license covers the code, not the Oddboro name. A fork needs a name of
its own.
