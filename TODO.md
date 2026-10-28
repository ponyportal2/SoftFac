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
- [x] A resumed issue whose branch already holds the work continues to review; "no commits" is a
      failure only when the branch has nothing ahead of the base.
- [x] After crash recovery requeues an issue, a cycle that lists nothing retries the ready list
      (three attempts, 1s/2s/3s) instead of reporting a no-op while the label index catches up.
- [x] The reviewer forks its per-area session into the worktree under review. pi refuses to resume a
      session recorded in another project directory and aborts silently, so the second issue in an
      area failed with "missing <review> block" and no agent output.
- [x] The implementer prompt forbids stopping processes it did not start. In no-sandbox mode the
      factory and the verifier look like ordinary node processes in `ps`, and an agent that tried
      to clean up an "orphaned runner" killed the factory running it.
- [x] `softfac run --help` started a second daemon instead of printing usage. Any subcommand
      with `--help` or `-h` now prints the usage and exits.
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
- [x] Feedback history is append-only: the factory records the branch head before the feedback
      implementer runs and blocks the issue when that commit is no longer an ancestor. An implementer
      that rebased away the architect's `arch: review` commit made the push non-fast-forward and
      silently dropped a review that had already been approved.
- [x] The reviewer is told that `docs/architecture/reviews` belongs to the architect. It used to
      flag those files as out-of-scope on a branch under review and ask for their removal, which is
      what pushed the implementer into rewriting history in the first place.
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

## Live pipeline test in GameInGame (2026-10-28)

Two benign issues exercised the factory end to end:
- #2 `documentation` -> PR #4, issue `softfac:needs-human`. Correct: normal work waits for a human.
- #3 `bug` -> PR #5, issue `softfac:needs-human`. Correct under the current config because
  `bugs.autoMerge` is `false`.

Both PRs were verified by the factory (`node tools/testing/verify.mjs --suite affected --since main`,
105 tests) and approved by the reviewer. The diffs are small and match their issues; the #2 text was
checked line by line against `timingSummary`.

It took eight runs to get here, and each failure was a real defect, now fixed:
1. model quoting: sandcastle wrapped the model in POSIX single quotes that `cmd.exe` kept literally.
2. idle timeout: the suite is silent for minutes, so the 600 s default killed run 2.
3. run 3 was stopped deliberately for the shutdown; crash recovery requeued it on the next start.
4. run 5 was killed by its own implementer, which saw the factory in `ps` and took it for an orphan.
5. run 6 was a no-op: requeue rewrote the label but the same cycle listed before GitHub's index caught up.
6. run 7 blocked on "no commits" because the resumed branch already held the fix from run 5.
7. run 8 resumed correctly, reviewed, verified, and opened PR #5.

Done on 2026-10-28: `softfac check-pr` passed on both PRs, both were merged by hand, #2 was closed
manually and #3 closed through the `Fixes #3` keyword. `main` is at the second merge commit and the
local checkout fast-forwards cleanly.

Later on 2026-10-28 the three remaining paths ran:

- **Auto-merge (issue #6, `bugs.autoMerge: true`).** The factory committed
  `Trim changed paths in verifier`, the reviewer approved, verification ran 105/105, and
  `gh pr merge --match-head-commit f430cab` merged PR #7 at 10:01:59Z. The issue auto-closed and
  the merge commit landed on `main`. Config reverted to `false` afterwards.
- **Architect (issue #8, `feature`, `requireForSubstantial: true`).** The implementer extracted
  `resolveSelection` and added `--list`; the reviewer approved; `[architect-8]` committed
  `arch: review 702f534` with `docs/architecture/reviews/2026-10-28-702f534.md` and the verdict
  `approved`. PR #9 opened and #8 entered the human pile.
- **Feedback loop (issue #8).** A real PR comment started a round: the implementer committed
  `Report empty verifier selections` with a regression test, the reviewer re-approved, a second
  architect commit reviewed it, and the gate re-ran. The push then failed as non-fast-forward
  because the reviewer had asked for the architect's review files to be removed and the implementer
  rebased them away. Three fixes: the implementer prompt declares history append-only, the factory
  records the pre-feedback head and blocks a branch that no longer contains it, and the reviewer
  prompt says `docs/architecture/reviews` is the architect's. The branch was restored with
  `git rebase --onto <remote head> <old base> softfac/8`.
  The retry then ran clean: `a0d1613 Document verifier test listing` -> reviewer approved ->
  `ae6dc13 arch: review a0d1613` -> guard passed -> pushed `c855e09..ae6dc13` as a fast-forward.
  Verification failed once on `package:contents` ("A test action is already pending"). The runner's
  `_bridge_action` gave up after 200 x 50ms and returned the still-`pending` answer, so the next
  dispatch was rejected and the assertion blamed the action after the one that stalled; `release`'s
  result was discarded as well. Fixed in GameInGame: poll to the deadline, return
  `{"ok": false, "timed_out": true}` naming the action, and assert `release`. PR #9 merged and #8
  closed by hand.

Remaining, in order:

1. Keep `bugs.autoMerge: false` until a few more real merges have been watched.
2. A failed feedback verification strands the round's commits on the local branch: the issue blocks
   and the next run asks the implementer to redo work that is already committed. Either record the
   feedback as addressed before verification, or let a re-run verify the existing head.

Gotchas seen during the test:
- The implementer sometimes emits `<promise>COMPLETE</promise>` and then hangs while a child
  verification finishes; sandcastle force-completes after a 60s grace window. Judge the run by the
  commit, not by the process exiting promptly.
- The Godot host tests can rewrite `GameSmith-Windows/GameSmith.pck`. If it shows up dirty,
  `git restore` and `git checkout --` hang on that file in this checkout (no process holds it;
  the filter path seems stuck). `git cat-file blob HEAD:<path> > /tmp/pck.bin && cp /tmp/pck.bin
  <path>` restores it instantly.
- Never run two factory instances against GameInGame; they share the worktree and the lock.
- `gh issue create --body "..."` in Git Bash eats backticks; write the body to a file and use
  `--body-file`.

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
- No-sandbox runs share the host process table, so an implementer can kill the factory or the
  verifier. The prompt rule is the only guard; a real sandbox would be needed to enforce it.
- Reviewer sessions are reused per area and forked into each new worktree, so every review copies
  the whole conversation into a new session file instead of appending to one.
