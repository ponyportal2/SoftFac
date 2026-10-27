# SoftFac

A Pi-native software factory. SoftFac turns a GitHub issue labelled `softfac:ready` into a
reviewed, policy-checked pull request using three long-lived agent roles:

| Role | Session | Responsibility |
| --- | --- | --- |
| **Implementer** | One session per issue, resumed across review rounds | Writes the change on a branch and commits it |
| **Reviewer** | One continuous session per issue area (bug, feature, ...) | Reviews the branch, approves or requests changes |
| **Architect** | Fresh session per review | Reviews the cumulative change for overarching design decisions |

Bugs are merged and closed automatically once the review gates pass and the live PR satisfies
the policy check. Everything else stops in a human review pile, where the operator decides.
Everything the agents do is committed to the branch, so the pull request is the audit trail.
Comments left on a waiting PR are fed back to the implementer, so the human reviews a moving
branch rather than a frozen one.

## How a run works

```
ready issue
   |
   v
sync base branch (fetch + fast-forward)
   |
   v
claim (softfac:running)  ->  create worktree + branch (softfac/<n>)
   |
   v
implementer  <---------------------+
   |                               |
   v                               |
reviewer ---------------------------+  changes requested (up to review.maxRounds)
   |  approved
   v
TDD gate (bug only): did the branch touch a test file?
   |
   v
architecture gate (every N commits, or always for substantial issues)
   |
   v
verification commands (optional) -> fail? block the issue
   |
   v
push -> open PR
   |
   v
policy check (local) -- fail? block the issue, keep the PR open
   |
   v
bug? merge + close : label softfac:needs-human
   |
   v
poll the PR for human feedback
   |
   v
new comment or change request?
   |  yes
   -> implementer -> reviewer -> verify -> push -> poll again
   |  no
   v
wait for the next poll
```

Every step records its outcome in `.softfac/state.json`, so restarting the daemon resumes
sessions instead of starting over.

Before claiming an issue, SoftFac fetches the base branch and fast-forwards the local copy when
it is strictly behind, so the worktree and the architecture diff start from the current base.
If the local branch has diverged (or the fast-forward would clobber a dirty working tree), the
sync is skipped with a warning and the run continues on the existing base.

**Crash recovery.** On the first cycle of a process, SoftFac requeues every issue whose recorded
status is `running`, `reviewing`, or `architecture` — it swaps `softfac:running` back to
`softfac:ready` and resets the record to `pending`. A record left in `feedback` is different:
the issue is already in the human pile, so it goes back to `pull-request` and the PR is polled
again instead of being re-claimed as fresh work. Sessions are persisted, so the resumed
implementer/reviewer continue where they stopped. PR creation is idempotent: if the branch
already has an open PR, that PR is reused and its title and body are refreshed, instead of
creating a duplicate or leaving a stale review summary behind.

**Daemon safety.** `softfac run` takes a single-instance lock at `.softfac/run.lock`; a second
daemon exits with the owner's pid instead of racing the first one, and a lock left by a dead
process is reclaimed. `SIGINT`/`SIGTERM` stop the loop after the current cycle, releasing the
worktree, sandbox, and lock. A cycle that throws is retried with exponential backoff and up to
20% jitter, capped at five minutes; a successful cycle resets the delay to `pollIntervalMs`.

## Requirements

- Node.js >= 20
- `gh` authenticated with permission to read issues and write pull requests
- `pi` on `PATH` (the agents run through Pi)
- `docker` or `podman` unless `sandbox` is set to `no-sandbox`

## Quick start

```bash
npm install
npm run build                        # emits dist/, which the `softfac` bin points at
npx softfac init --repo owner/repo   # writes .softfac/config.json + prompts
# edit .softfac/config.json (repo, base branch, models, cadence)
npx softfac labels                   # create the labels the factory needs
npx softfac doctor                   # verify the git repo, gh, pi, and the sandbox
npx softfac run --once               # process one batch
npx softfac run                      # run continuously, polling every pollIntervalMs
```

`init` is safe to re-run: it only creates files that do not exist yet, and it never overwrites
prompts you have edited.

## Issue kinds and the PR policy

An issue's labels decide how its pull request may land. The policy is enforced twice: the
factory builds the PR body to match, and the auto-merge path runs `softfac check-pr` against
the live PR before merging. If the check fails, the factory blocks the issue and leaves the PR
open — it never merges on the strength of the agent's own verdict. The merge is also pinned to
the commit that was verified: the factory records the branch head after the gate and
verification, pushes, and merges with `--match-head-commit`. If the merge fails — for example
because the PR head moved in between — the issue is blocked rather than merged unverified.

There is no server-side policy enforcement. GitHub supplies the pull request surface and branch
protection; the policy check is a local command. A human who merges a PR by hand can bypass it,
so the operator is the enforcement point for manual merges. SoftFac's guarantee covers the
merges it performs itself.

| Kind | Label | PR must | Lands |
| --- | --- | --- | --- |
| **Bug** | `bug` | close with `Fixes #N` and check the regression-test box | merged + issue closed when `bugs.autoMerge` is on and verification is configured |
| **Substantial** | any of `feature`, `architecture`, `epic` | reference with `Part of #N`, carry `arch:approved` | human review pile |
| **Normal** | anything else | reference with `Part of #N` | human review pile |

The "human review pile" is the `softfac:needs-human` label plus a comment linking the PR.

**Reacting to review comments.** While an issue sits in the pile, every cycle polls its PR for
comments and change-request reviews from trusted authors — owners, collaborators, organization
members, and allowlisted logins. Comments from outsiders are ignored, so a public repository
cannot steer the implementer. New feedback is handed to the implementer
as review notes, the reviewer re-reviews, and — for substantial issues — the architecture gate
runs again on the new commits. A rejection blocks the issue; otherwise the verification
commands run and the result is pushed to the same branch. Handled comments are recorded by id in
the state file, so the same comment is never implemented twice; a `MERGED` or `CLOSED` PR is
skipped. If the reviewer still requests changes after `review.maxRounds` extra rounds, the
issue is blocked instead. The label stays put: merging the PR or removing the label is the
human's decision, not the factory's.

`softfac check-pr --repair` is a manual recovery command. When a PR violates the policy and
the issue it references is already closed (a closing keyword landed too early, or a bug PR was
merged without its regression test), it reopens the issue. A compliant PR that closed its bug
issue is left alone. The repair is deliberately narrow: it only touches a PR whose branch
starts with `branchPrefix`, whose head is in the same repository, and whose issue still carries
one of the factory's labels. Everything else is reported and left unchanged. Nothing runs it
automatically.

## Architecture reviews

The architect reviews **the commits added since the last architecture review**, not the whole
repository. The reviewed range starts at `state.architecture.lastReviewedBaseSha` — the head of
the base branch at the time of the last review — and is verified with `git merge-base
--is-ancestor`. If that anchor is no longer an ancestor of the branch (for example after a
force-push), the review falls back to counting commits on the branch itself.

A review runs when either:

- at least `architecture.everyCommits` commits have accumulated since the anchor, or
- the issue is substantial and `architecture.requireForSubstantial` is true.

Each review:

1. Sends the diff, the commit count, the previous decisions, and a repository context to the
   architect. The context lists the changed files, a module inventory, architecture documents
   (ADRs and review notes), dependency manifests, and the paths of any coverage reports, and it
   includes the contents of the five newest decision documents — numbered ADRs first, review
   notes excluded because prior decisions are already in the prompt — each capped at 4,000
   characters. The diff is capped at `architecture.maxDiffChars`; a larger range is truncated
   with an explicit marker so the prompt stays within a predictable size.
2. Files every follow-up that no earlier review raised as a `softfac:follow-up` issue. A failed
   issue creation is logged and does not block the PR.
3. Commits `docs/architecture/reviews/<date>-<sha>.md` to the branch, linking filed follow-ups.
4. Applies `arch:approved` or `arch:changes-requested` to the issue.
5. Appends the decision (summary, follow-ups, and the issue filed for each) to state, keeping
   the last 10.

Because decisions are persisted and fed back into the prompt, the architect stays consistent
between reviews instead of re-litigating settled questions, and a follow-up that is still in the
retained decision history is not filed again. An `arch:changes-requested` verdict
blocks the issue rather than looping back to the implementer — the human decides how to proceed.

Follow-ups are **not** promoted automatically. An architect that files work the factory
immediately implements would feed itself, and each new review would file the next batch. The
`softfac:follow-up` label is informational: read the pile, then add `softfac:ready` to the
follow-ups worth doing. That label is all the factory needs, and `softfac status` shows the
issue number filed for each follow-up.

## The TDD gate

A bug fix is only credible if a test changed. After the reviewer approves, the factory checks
the branch's changed files against `tdd.testPatterns`:

```json
"tdd": { "testPatterns": ["tests/**", "test/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**"] }
```

If no file matches, the implementer gets a synthetic `changes_requested` round asking for a
regression test. If the rounds run out, the issue is blocked. This is what makes the
"Regression test added" checkbox in a bug PR body truthful: `check-pr` can only read the box,
so this gate is the evidence behind it. Other issue kinds are not gated.

## Verification

Reviewers read the code; they do not run it. Configure the commands the factory should run
before it opens a PR:

```json
"verification": { "commands": ["npm ci", "npm test", "npm run typecheck"] }
```

The commands run sequentially inside the issue's sandbox, from the worktree root, and stop at
the first non-zero exit. A failure blocks the issue with the command, its exit code, and the
last 20 lines of output; no PR is opened. A pass is recorded in the PR body as
"Verified by SoftFac: `npm test`, ..." instead of the default "no verification commands are
configured" note.

A fresh worktree contains only committed files — no `node_modules` — and the sandbox
bind-mounts that worktree over the repository path, so dependencies baked into the image are
shadowed. Put the install step first (as above), and make sure the sandbox image provides the
toolchain the commands need. Leaving `verification.commands` empty disables the step, and the
PR body then says plainly that nothing was run.

## Configuration

`.softfac/config.json` is validated strictly: unknown shapes and wrong types are errors, not
silently ignored.

| Key | Default | Meaning |
| --- | --- | --- |
| `repo` | `""` | GitHub `owner/repo` |
| `baseBranch` | `main` | Branch the factory branches from and merges into |
| `branchPrefix` | `softfac/` | Prefix for issue branches (`softfac/42`) |
| `labels.ready` | `softfac:ready` | Label that opts an issue into the factory |
| `labels.running` | `softfac:running` | Applied while an issue is being processed |
| `labels.blocked` | `softfac:blocked` | Applied when the factory gives up |
| `labels.needsHuman` | `softfac:needs-human` | The human review pile |
| `labels.followUp` | `softfac:follow-up` | Label on issues filed from architecture follow-ups |
| `labels.bug` | `bug` | Classifies an issue as a bug |
| `labels.substantial` | `feature`, `architecture`, `epic` | Classifies an issue as substantial |
| `architecture.everyCommits` | `10` | Review cadence |
| `architecture.requireForSubstantial` | `true` | Always review substantial changes |
| `architecture.maxDiffChars` | `60000` | Character cap on the diff sent to the architect |
| `review.maxRounds` | `2` | Extra implement/review rounds after the first review; also caps a human-feedback batch |
| `review.trustedAuthors` | `[]` | Extra logins trusted to comment |
| `tdd.testPatterns` | see above | Glob patterns that count as test files |
| `verification.commands` | `[]` | Commands run in the sandbox before opening a PR |
| `bugs.autoMerge` | `false` | Merge bug PRs automatically; requires at least one `verification.commands` entry |
| `bugs.autoClose` | `true` | Close the bug issue after merging |
| `maxIssuesPerRun` | `1` | Issues claimed per polling cycle |
| `pollIntervalMs` | `60000` | Daemon poll interval |
| `sandbox` | `docker` | `docker`, `podman`, or `no-sandbox` |
| `agents.*Model` | `claude-sonnet-4-6` / `claude-opus-4-8` | Model per role |
| `agents.thinking` | unset | Thinking level for all roles |
| `agents.idleTimeoutSeconds` | runner default (600) | Silence before a run is killed; raise it for long verification commands |
| `prompts.*` | `.softfac/prompts/*.md` | Prompt templates |
| `statePath` | `.softfac/state.json` | Durable state |
| `logDir` | `.softfac/logs` | Run logs |

## Prompts

Prompts are plain Markdown with `{{PLACEHOLDER}}` substitution. Every role receives
`ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_URL`, `ISSUE_LABELS`, `BRANCH`, and
`BASE_BRANCH`. Additionally:

- **Implementer**: `REVIEW_FEEDBACK` — the previous review, or "None. This is the initial implementation."
- **Reviewer**: `IMPLEMENTER_SESSION` — the implementer's session id.
- **Architect**: `FROM_SHA`, `TO_SHA`, `COMMITS`, `DIFF`, `REPOSITORY_CONTEXT`,
  `PRIOR_DECISIONS`.

The reviewer must answer with a `<review>{"verdict":"approved"|"changes_requested",...}</review>`
block and the architect with `<architecture>{...}</architecture>`. Both blocks are validated
against a zod schema (verdict enum, non-empty summary, string lists); a missing block or an
invalid field fails the issue rather than guessing a verdict.

## Branch protection

There are no GitHub Actions. `softfac check-pr` is a local command; GitHub supplies the pull
request surface. Protect the base branch with a repository ruleset or branch protection rule
that requires a pull request and blocks force pushes and deletions. Do not require reviews or
status checks: nothing produces them, and a required check that never runs blocks every merge.

Branch protection cannot enforce the SoftFac policy, because the policy is evaluated by a local
command. It does keep every change on the PR path and makes history rewrites visible. For
factory merges, enforcement is the local gate plus `--match-head-commit`.

## State and logs

`.softfac/state.json` holds:

- `sessions` — implementer sessions per issue, one continuous reviewer session per area
  (`reviewer:bug`, `reviewer:feature`, ...), and no architect session (the architect always
  starts fresh).
- `issues` — status (`pending`, `running`, `reviewing`, `architecture`, `feedback`,
  `pull-request`, `blocked`, `done`, `failed`), branch, PR number, handled feedback ids.
- `architecture` — the review anchor and the last 10 decisions.

Writes are atomic (temp file + rename) and the file is versioned; version 1 state is migrated
on read. Corrupt state is an error, never a silent reset. `softfac status` renders the same
information without opening the file.

## CLI

```
softfac init [--repo owner/repo]   Create config, prompts, and review directories
softfac doctor                     Check config, the git repo and origin, gh, pi, the sandbox
softfac labels                     Create missing labels (never overwrites existing ones)
softfac status                     Show recorded issues, sessions, and architecture decisions
softfac run [--once]               Process ready issues and PR feedback continuously, or once
softfac check-pr <number> [--repair]  Enforce the PR policy; --repair reopens a closed issue
```

## Development

```bash
npm test          # node:test via tsx
npm run typecheck # tsc --noEmit
npm run build     # emit dist/
```

The code is ports-and-adapters: `src/ports.ts` defines `AgentRunner`, `IssueTracker`,
`GitOps`, `StateStore`, and `FactoryLogger`; `src/factory.ts` contains the workflow and
depends only on those ports. Tests drive the factory through in-memory fakes in
`tests/support/fakes.ts`, so the whole pipeline runs without `gh`, `pi`, or Docker.

## Limitations

- Every new human comment on a waiting PR is treated as a change request, so a non-actionable
  comment (a plain "thanks", say) still starts a feedback round.
- `review.maxRounds` counts extra rounds after the initial review.
- The architect sees the diff of the reviewed range, a repository outline, and the five newest
  ADRs, not the contents of the whole repository.
- Reviewer sessions are reused per area, not per repository; a very long-lived session can still
  drift, which is why the review loop is capped.
- Verification commands run once, after the architecture gate; a failure blocks the issue
  instead of sending the output back to the implementer.
- Only the PR conversation and review bodies are read. Inline review comments on a diff are
  not fetched, so a reviewer who leaves line notes without a summary comment is not heard.
- A manual merge can bypass the PR policy: there is no server-side check, so the operator is
  the enforcement point. SoftFac only guarantees that it never auto-merges code it did not
  verify.
