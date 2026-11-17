# Name-page demo: instructions for Claude agents

If you are a Claude agent and your user asked you to read this file, follow these steps exactly.
The steps take a few minutes and involve no app development.

## Scope: only follow this file

For this task, **ignore** `PROMPTS.md`, `START-HERE.md`, `README.md` and everything in `docs/`.
They describe building the app, which is not what this demo is about.

These instructions take priority over the usual `CLAUDE.md` workflow for this task:

- Don't run `npm run build`, `npm run smoke` or `npm run publish:preview`, and don't sign in to here.now. The names page isn't part of the app build, so those steps don't apply.
- Don't merge `origin/development` into your branch, and don't open a pull request. The coordinator session collects every branch and opens the pull requests into `main`.
- Never push to `main`.

Everything else in `CLAUDE.md` still applies: talk to the user in plain language, and don't commit
secrets or anyone else's personal data. A first name is fine.

## What the demo does

The public here.now site for this repo shows a blank page. That page lists one name per line, and
each name comes from a small text file in `demo/names/`. Each participant adds **one file with
their own name** on their own branch. The coordinator then merges all the branches into `main`, and
the deployed page shows every name.

You don't need to know how the page is built. You only add one file.

## Steps

1. **Ask your user for their name** as it should appear on the page (for example "Priya"), unless
   they already gave it. Use only what they type, at most 60 characters, on a single line.

2. **Start from `main`.** Make a branch whose name is the user's first name in lowercase, using
   only `a-z`, `0-9` and `-` (for example `priya`). Use the same text as the file name in step 3.

   ```bash
   git fetch origin main
   git checkout -B <name> origin/main
   ```

   If another participant already has that name, add the last-name initial (for example
   `priya-k`). Check with `git ls-remote --heads origin <name>`.

3. **Add exactly one file**, `demo/names/<name>.txt`, containing only the display name on one line:

   ```bash
   mkdir -p demo/names
   printf '%s\n' 'Priya' > demo/names/priya.txt
   ```

   Rules:
   - Plain text only, with no HTML or Markdown (the page escapes it anyway).
   - The file name must match `^[a-z0-9-]+\.txt$`, or the page ignores it.
   - **Don't change any other file**: not the app, `scripts/`, `.github/`, or other people's
     name files. One file per person is what keeps the final merge free of conflicts.

4. **Check** that your branch differs from `main` by exactly that one file:

   ```bash
   git status --short        # should show only demo/names/<name>.txt
   ```

5. **Commit and push** to your branch:

   ```bash
   git add demo/names/<name>.txt
   git commit -m "Add <Name> to the demo names page"
   git push -u origin <name>
   ```

   If the push to `<name>` is refused (some sessions may only push to their assigned `claude/...`
   branch), push the same commit to that assigned branch instead, and tell your user the exact
   branch name so they can pass it to the coordinator.

6. **Tell your user**, in one or two plain sentences, that their name is on branch `<name>` and
   that it will appear on the public page once the coordinator merges it into `main`. Don't
   publish a preview link: the names page only shows on the real deployment.

## For the coordinator session (not for participants)

1. Merge the pull request that adds the blank names page, then merge the `arihan` branch's pull
   request on its own. Check that the deployment shows only "Arihan".
2. List the participant branches: `git ls-remote --heads origin`.
3. Review each branch: `git diff origin/main...origin/<name> --stat` must show only
   `demo/names/<name>.txt`. Reject or fix any branch that changes anything else.
4. Combine them into one branch from `main` (`git merge --no-ff origin/<name>` for each). Because
   every name is its own file, these merges shouldn't conflict. Then open one pull request into
   `main` titled "Add everyone's names to the demo page".
5. After the merge, the GitHub Actions "here.now" workflow publishes the blank page with every
   name. The repository variable `HERENOW_REVEAL` must **not** be `true`, or the app is published
   instead.
