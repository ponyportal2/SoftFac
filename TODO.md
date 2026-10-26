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
  `verification.commands` is non-empty, and only when the live PR passes the same policy check
  CI runs; a failed check blocks the issue instead of merging.
- Substantial changes land in the human approval pile (`softfac:needs-human`).
- A read-only GitHub Action reports the PR policy; a separate trusted post-merge Action reopens
  an issue closed by a non-compliant PR.

## Current state (2026-10-26)

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
- [x] Merge gate: before a bug is auto-merged, the factory runs `check-pr`'s policy against the
      live PR. A violation or a failed check blocks the issue and leaves the PR open.
- [x] Auto-merge is bound to the verified commit: the branch head is recorded after the gate and
      verification and passed to `gh pr merge --match-head-commit`. A failed merge — for example a
      head that moved in between — blocks the issue instead of merging something unverified.
- [x] Architecture follow-ups become `softfac:follow-up` issues, deduplicated against the
      retained decision history; a failed issue creation only logs a warning.
- [x] The architect receives a repository context: changed files, module inventory, architecture
      documents, dependency manifests, and coverage report paths, in addition to the capped diff.
- [x] `check-pr --repair` reopens an issue that a non-compliant PR closed; a separate
      `pull_request_target` Action runs it with `issues: write` after a merge.
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
- [x] Human approvals are head-bound: only the newest decisive review per author counts (a
      comment-only review is neutral), and only when it was submitted on the PR's current head
      commit. A new push drops the approval. Only the owner or an allowlisted login may approve;
      organization membership is enough for feedback, not for approval.
- [x] A substantial feedback round re-runs the architecture gate on the new commits before the
      push; a rejection blocks the issue and nothing is pushed.
- [x] `bugs.autoMerge` defaults to `false`, and enabling it without a verification command is a
      config error, so an unverified merge cannot be configured.
- [x] The policy Action builds the trusted base commit (`pull_request.base.sha`) instead of the
      PR merge ref and holds no write scopes; the post-merge repair runs from trusted
      `pull_request_target` YAML with `issues: write`.
- [x] `check-pr --repair` only touches a PR from the factory's branch prefix, in the same
      repository, whose issue still carries a factory label.
- [x] 242 tests, typecheck clean, `npm run build` clean.

## Next (pick up here)

Security bootstrap:

1. Smoke-test the read-only policy Action with a compliant bug PR. Bugs need no human approval,
   so this exercises the build and policy path without an identity split.
2. Split identities before testing normal/feature PRs: a GitHub App (preferred for unattended
   operation) or a second human approver. `ponyportal2` authors every PR today, and GitHub
   forbids self-approval.
3. Keep `bugs.autoMerge: false`.
4. Only after a successful smoke test, protect `main` (require a PR, require approvals, no
   force-push, no deletion). Leave the `policy` check advisory: it is PR-forgeable.
5. Later, if server-side policy enforcement is wanted, have a GitHub App post `softfac/policy`
   at the verified head and bind branch protection to that app as the expected source.

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

- Every new trusted comment on a waiting PR is treated as a change request, so a non-actionable
  comment still starts a feedback round.
- Inline review comments on a diff are not fetched; only the PR conversation and review bodies
  are read.
- `MEMBER` and `COLLABORATOR` can give feedback but cannot approve. Approval is limited to the
  repository owner or `review.trustedAuthors`; write-access maintainers must be allowlisted.
- Approvals come from a single `gh pr view --json reviews` call. If that list is capped, a very
  busy PR could hide the newest review; pagination is not implemented.
- The architect sees the diff plus a repository outline, not the whole repository.
- Reviewer sessions are reused per area, so a very long-lived session can still drift.
- The repair workflow builds whatever is on the default branch at the time of a later `closed`
  event, so any merged change to the trusted policy/repair execution surface — workflow YAML,
  `package.json`/lockfile and lifecycle scripts, build scripts, or `src/` modules imported by
  `check-pr` — runs with `issues: write`. With `bugs.autoMerge: false` every merge is
  human-reviewed; if bug auto-merge is enabled, changes to that surface must not be unattended.
  The exact path rule is deferred until auto-merge is enabled.
