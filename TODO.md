# SoftFac TODO

Living plan. Rewrite freely as the design becomes clearer.

## What SoftFac is

A Pi-native software factory:
- An **implementer** Pi session works one GitHub issue at a time on a branch.
- A **reviewer** Pi session is continuous across issues and approves or requests changes.
- An **architect** Pi session reviews the cumulative change on a cadence (every N commits)
  and always for substantial issues.
- Bugs are auto-merged and auto-closed after review; substantial changes land in the
  human approval pile (`softfac:needs-human`).
- A GitHub Action enforces the PR policy (issue reference, regression test, approvals).

## Current state (2026-10-24)

- [x] Core pipeline: claim -> implement -> review loop -> architecture gate -> PR -> merge/close.
- [x] Config parsing, labels, init scaffolding, doctor, check-pr, GitHub Action.
- [x] File state store with atomic writes; sessions persisted across restarts.
- [x] Architecture reviews anchored to the base branch (squash-merge safe) with persisted
      decisions fed back to the architect.
- [x] Factory-level TDD gate for bug fixes.
- [x] Non-destructive label sync and README documentation.
- [x] Base branch sync before each issue: fetch + fast-forward, skipped (with a warning) when
      the local base has diverged or the tree is dirty. Covered by a real bare-remote test.
- [x] Crash recovery: in-flight issues are requeued on the first cycle, and PR creation reuses
      an open PR for the branch instead of duplicating it.
- [x] Worktrees are released as soon as an issue finishes (success, block, or failure), and
      `softfac status` renders state without opening the JSON file.
- [x] PR bodies no longer claim a test/typecheck pass that never ran.
- [x] `softfac doctor` verifies that the working directory is a git repo with an `origin` remote.
- [x] Verification commands: `verification.commands` run sequentially in the issue's sandbox
      before the PR opens, stop at the first failure, and block the issue with the exit code and
      the tail of the output. The PR body records what passed.
- [x] Agent verdicts are validated with zod schemas; missing `findings`/`followUps` default
      to an empty list.
- [x] The architecture diff is capped at `architecture.maxDiffChars` (default 60k) with an
      explicit truncation marker in the prompt.
- [x] 176 tests, typecheck clean, `npm run build` clean.

## Next (pick up here)

1. **Refresh the PR body when reusing an open PR.** After a crash the factory reuses the PR the
   previous run opened, but its body still describes the older review. Add
   `IssueTracker.updatePullRequest` (`gh pr edit`) and rewrite the title/body when
   `createPullRequest` returns an existing PR.
2. **React to human PR review comments.** Poll PR reviews for issues in the human approval pile,
   feed the latest human comment to the implementer as review feedback, re-review, and push.
   Needs a decision on the round cap and on who clears `softfac:needs-human`.

## Ideas / not scheduled

- Cost/token accounting per issue from Pi's session metadata.
- Allow the architect to file follow-up issues instead of only writing them into state.

## Known limitations

- The factory does not react to human review comments on a PR; a blocked or human-review
  issue is resumed only by re-labelling it.
- `maxRounds` counts extra rounds after the initial review, not total reviews.
- The architect sees the diff of the reviewed range, not the full repository.
- An `arch:changes-requested` verdict blocks the issue instead of looping back to the
  implementer; the human decides the next step.
- Verification runs once, after the architecture gate; a failure blocks the issue instead of
  sending the failing output back to the implementer.
- A fresh worktree has no dependencies, so `verification.commands` must install them first
  (for example `npm ci`).
- Sandcastle's `Output.object` is only available on the top-level `run()`, which creates its
  own worktree. SoftFac reuses one worktree across the implementer, reviewer, and architect
  (`Worktree.run`/`Sandbox.run` have no `output` option), so verdicts are still extracted
  from XML blocks — now validated with zod instead of hand-rolled checks.
