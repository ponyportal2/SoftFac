# SoftFac TODO

Living plan. Rewrite freely as the design becomes clearer.

## What SoftFac is

A Pi-native software factory:
- An **implementer** Pi session works one GitHub issue at a time on a branch.
- A **reviewer** Pi session is continuous per issue area (bug, feature, ...) and approves or
  requests changes.
- An **architect** Pi session reviews the cumulative change on a cadence (every N commits)
  and always for substantial issues.
- Bugs are auto-merged and auto-closed after review when `bugs.autoMerge` is on and
  `verification.commands` is non-empty, and only when the live PR passes `check-pr`; a failed
  check blocks the issue instead of merging.
- Normal and substantial changes land in the human review pile (`softfac:needs-human`).
- There are no GitHub Actions. `softfac check-pr` is a local command; GitHub provides the PR
  surface and basic branch protection.

## Current state (2026-10-26)

- [x] Core pipeline: claim -> implement -> review loop -> architecture gate -> PR -> merge/close.
- [x] Config parsing, labels, init scaffolding, doctor, check-pr.
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
- [x] The scaffolded implementer prompt asks for the project's tests and documented checks
      instead of assuming a typecheck step, and names the architect-owned docs path unambiguously.
- [x] Windows no-sandbox runs pass the model and session to pi without POSIX quoting, which
      cmd.exe keeps literally and pi rejects as an unknown model.
- [x] `agents.idleTimeoutSeconds` raises the runner's silence window for projects whose
      verification command legitimately produces no agent output for many minutes.
- [x] `softfac doctor` verifies that the working directory is a git repo with an `origin` remote.
- [x] Verification commands: `verification.commands` run sequentially in the issue's sandbox
      before the PR opens, stop at the first failure, and block the issue with the exit code and
      the tail of the output. The PR body records what passed.
- [x] Agent verdicts are validated with zod schemas; missing `findings`/`followUps` default
      to an empty list.
- [x] The architecture diff is capped at `architecture.maxDiffChars` (default 60k) with an
      explicit truncation marker in the prompt.
- [x] Merge gate: before a bug is auto-merged, the factory runs `check-pr`'s policy against the
      live PR. A violation or a failed check blocks the issue and leaves the PR open.
- [x] Auto-merge is bound to the verified commit: the branch head is recorded after the gate and
      verification and passed to `gh pr merge --match-head-commit`. A failed merge — for example a
      head that moved in between — blocks the issue instead of merging something unverified.
- [x] Architecture follow-ups become `softfac:follow-up` issues, deduplicated against the
      retained decision history; a failed issue creation only logs a warning.
- [x] The architect receives a repository context: changed files, module inventory, architecture
      documents, dependency manifests, and coverage report paths, in addition to the capped diff.
- [x] `check-pr --repair` reopens an issue that a non-compliant PR closed. It is a manual
      recovery tool; nothing runs it automatically.
- [x] Daemon hygiene: single-instance lock with stale-lock recovery, `SIGINT`/`SIGTERM` stop
      after the current cycle, and exponential backoff with jitter on failed cycles.
- [x] Reviewer sessions are keyed by issue area (`reviewer:bug`, `reviewer:feature`, ...)
      instead of one immortal session for the whole repository.
- [x] Reusing an open PR after a crash refreshes its title and body with `gh pr edit`.
- [x] Human PR feedback: while an issue waits in the human pile, each cycle polls its PR for
      comments and change-request reviews, hands them to the implementer, re-reviews, verifies,
      and pushes. Handled ids live on the issue record, so a comment is never implemented twice.
- [x] An interrupted feedback run recovers to `pull-request` and re-polls the PR instead of
      requeueing the issue as fresh work.
- [x] `softfac status` and the architect prompt show the issue filed for each follow-up
      (`filed as #N`), persisted on the decision record.
- [x] Follow-up triage decided: no automatic promotion. The label is informational and a human
      adds `softfac:ready` to the follow-ups worth doing, so the factory cannot feed itself.
- [x] The architect reads the contents of the five newest decision documents (numbered ADRs
      first, review notes excluded, 4,000 characters each) instead of only their paths.
- [x] PR feedback is trusted-only: comments and reviews from `OWNER`, `MEMBER`,
      `COLLABORATOR`, or `review.trustedAuthors` steer the implementer; outsiders are ignored.
- [x] A substantial feedback round re-runs the architecture gate on the new commits before the
      push; a rejection blocks the issue and nothing is pushed.
- [x] `bugs.autoMerge` defaults to `false`, and enabling it without a verification command is a
      config error, so an unverified merge cannot be configured.
- [x] Human approval is no longer a policy rule. SoftFac only auto-merges bugs, so the rule could
      not protect an automated path, and it made the manual checker impossible to satisfy when
      the owner also authors the PR.
- [x] Both Actions workflows were deleted, along with the `pull_request_target` event policy.
      The PR-controlled-YAML, repair-token, and 2026-12-02 deadline problems are gone.
- [x] `check-pr --repair` only touches a PR from the factory's branch prefix, in the same
      repository, whose issue still carries a factory label.
- [x] `main` is protected by a repository ruleset: a pull request is required, force pushes
      and deletions are blocked, and there are no required reviews or checks.
- [x] 232 tests, typecheck clean, `npm run build` clean.

## Next (pick up here)

1. Run one real normal PR end-to-end: the factory opens it, you review the diff and merge. This
   proves the PR path without the Actions layer.
2. Keep `bugs.autoMerge: false` for several real cycles. Before enabling it, make sure
   `verification.commands` is non-empty and watch the first few merges.
3. Decide later whether GitHub-native required reviews are worth a second identity. Only then
   reintroduce a GitHub App and the approval rule in the policy.
4. Optional: a plain read-only CI workflow for `npm test`, typecheck, and build. Keep it
   separate from SoftFac policy and do not treat it as a security boundary.

Then, roughly in value order:

1. Per-area reviewer prompts (a bug reviewer cares about regression tests; a feature reviewer
   about design).
2. Cost/token accounting per issue from Pi's session metadata.

## Ideas / not scheduled

- Per-area round limits.
- A `softfac follow-ups` command that lists the open follow-up pile.
- Paginate reviews (or fail when the list looks truncated) instead of trusting one page.
- Fetch inline review comments, not just the PR conversation and review bodies.

## Known limitations

- A manual merge can bypass SoftFac's policy: there is no server-side check. The operator is the
  enforcement point. SoftFac only guarantees that it never auto-merges code it did not verify.
- `check-pr --repair` is manual; nothing reopens an issue automatically after a bad merge.
- Every new trusted comment on a waiting PR is treated as a change request, so a non-actionable
  comment still starts a feedback round.
- Inline review comments on a diff are not fetched; only the PR conversation and review bodies
  are read.
- The architect sees the diff plus a repository outline, not the whole repository.
- Reviewer sessions are reused per area, so a very long-lived session can still drift.
