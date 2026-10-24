# SoftFac

A Pi-native software factory. SoftFac turns a GitHub issue labelled `softfac:ready` into a
reviewed, policy-checked pull request using three long-lived agent roles:

| Role | Session | Responsibility |
| --- | --- | --- |
| **Implementer** | One session per issue, resumed across review rounds | Writes the change on a branch and commits it |
| **Reviewer** | One continuous session across all issues | Reviews the branch, approves or requests changes |
| **Architect** | Fresh session per review | Reviews the cumulative change for overarching design decisions |

Bugs are merged and closed automatically once the review gates pass. Substantial changes stop at
a human approval gate. Everything the agents do is committed to the branch, so the pull request
is the audit trail.

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
push -> open PR -> bug? merge + close : label softfac:needs-human
```

Every step records its outcome in `.softfac/state.json`, so restarting the daemon resumes
sessions instead of starting over.

Before claiming an issue, SoftFac fetches the base branch and fast-forwards the local copy when
it is strictly behind, so the worktree and the architecture diff start from the current base.
If the local branch has diverged (or the fast-forward would clobber a dirty working tree), the
sync is skipped with a warning and the run continues on the existing base.

**Crash recovery.** On the first cycle of a process, SoftFac requeues every issue whose recorded
status is `running`, `reviewing`, or `architecture` — it swaps `softfac:running` back to
`softfac:ready` and resets the record to `pending`. Sessions are persisted, so the resumed
implementer/reviewer continue where they stopped. PR creation is idempotent: if the branch
already has an open PR, that PR is reused instead of creating a duplicate.

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
npx softfac labels                   # create the labels the workflow needs
npx softfac doctor                   # verify the git repo, gh, pi, and the sandbox
npx softfac run --once               # process one batch
npx softfac run                      # run continuously, polling every pollIntervalMs
```

`init` is safe to re-run: it only creates files that do not exist yet, and it never overwrites
prompts you have edited.

## Issue kinds and the PR policy

An issue's labels decide how its pull request may land. The policy is enforced twice: the
factory builds the PR body to match, and `softfac check-pr` (run by the bundled GitHub Action)
rejects a PR that drifts.

| Kind | Label | PR must | Lands |
| --- | --- | --- | --- |
| **Bug** | `bug` | close with `Fixes #N` and check the regression-test box | merged + issue closed when `bugs.autoMerge` |
| **Substantial** | any of `feature`, `architecture`, `epic` | reference with `Part of #N`, carry `arch:approved`, have 1 human approval | human approval pile |
| **Normal** | anything else | reference with `Part of #N`, have 1 human approval | human approval pile |

The "human approval pile" is the `softfac:needs-human` label plus a comment linking the PR.
The policy action re-runs on every push, label change, and review, so the required check turns
green as soon as a human approves.

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

1. Sends the diff, the commit count, and the previous decisions to the architect. The diff is
   capped at `architecture.maxDiffChars`; a larger range is truncated with an explicit marker
   so the prompt stays within a predictable size.
2. Commits `docs/architecture/reviews/<date>-<sha>.md` to the branch.
3. Applies `arch:approved` or `arch:changes-requested` to the issue.
4. Appends the decision (summary and follow-ups) to state, keeping the last 10.

Because decisions are persisted and fed back into the prompt, the architect stays consistent
between reviews instead of re-litigating settled questions. An `arch:changes-requested` verdict
blocks the issue rather than looping back to the implementer — the human decides how to proceed.

## The TDD gate

A bug fix is only credible if a test changed. After the reviewer approves, the factory checks
the branch's changed files against `tdd.testPatterns`:

```json
"tdd": { "testPatterns": ["tests/**", "test/**", "**/*.test.*", "**/*.spec.*", "**/__tests__/**"] }
```

If no file matches, the implementer gets a synthetic `changes_requested` round asking for a
regression test. If the rounds run out, the issue is blocked. This is what makes the
"Regression test added" checkbox in a bug PR body truthful. Other issue kinds are not gated.

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
| `labels.needsHuman` | `softfac:needs-human` | The human approval pile |
| `labels.bug` | `bug` | Classifies an issue as a bug |
| `labels.substantial` | `feature`, `architecture`, `epic` | Classifies an issue as substantial |
| `architecture.everyCommits` | `10` | Review cadence |
| `architecture.requireForSubstantial` | `true` | Always review substantial changes |
| `architecture.maxDiffChars` | `60000` | Character cap on the diff sent to the architect |
| `review.maxRounds` | `2` | Extra implement/review rounds after the first review |
| `tdd.testPatterns` | see above | Glob patterns that count as test files |
| `verification.commands` | `[]` | Commands run in the sandbox before opening a PR |
| `bugs.autoMerge` | `true` | Merge bug PRs automatically |
| `bugs.autoClose` | `true` | Close the bug issue after merging |
| `maxIssuesPerRun` | `1` | Issues claimed per polling cycle |
| `pollIntervalMs` | `60000` | Daemon poll interval |
| `sandbox` | `docker` | `docker`, `podman`, or `no-sandbox` |
| `agents.*Model` | `claude-sonnet-4-6` / `claude-opus-4-8` | Model per role |
| `agents.thinking` | unset | Thinking level for all roles |
| `prompts.*` | `.softfac/prompts/*.md` | Prompt templates |
| `statePath` | `.softfac/state.json` | Durable state |
| `logDir` | `.softfac/logs` | Run logs |

## Prompts

Prompts are plain Markdown with `{{PLACEHOLDER}}` substitution. Every role receives
`ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_URL`, `ISSUE_LABELS`, `BRANCH`, and
`BASE_BRANCH`. Additionally:

- **Implementer**: `REVIEW_FEEDBACK` — the previous review, or "None. This is the initial implementation."
- **Reviewer**: `IMPLEMENTER_SESSION` — the implementer's session id.
- **Architect**: `FROM_SHA`, `TO_SHA`, `COMMITS`, `DIFF`, `PRIOR_DECISIONS`.

The reviewer must answer with a `<review>{"verdict":"approved"|"changes_requested",...}</review>`
block and the architect with `<architecture>{...}</architecture>`. Both blocks are validated
against a zod schema (verdict enum, non-empty summary, string lists); a missing block or an
invalid field fails the issue rather than guessing a verdict.

## GitHub Action

`.github/workflows/softfac-policy.yml` builds the project and runs
`node dist/cli.js check-pr <number>` on every PR event. It requires `GH_TOKEN` (the default
token is enough) and fails the check with one line per violation. Keep this workflow in the
repository you are automating, and make the check required in branch protection if you want the
policy to be a hard gate.

## State and logs

`.softfac/state.json` holds:

- `sessions` — implementer sessions per issue, the continuous reviewer session, and no
  architect session (the architect always starts fresh).
- `issues` — status (`pending`, `running`, `reviewing`, `architecture`, `pull-request`,
  `blocked`, `done`, `failed`), branch, PR number, review rounds.
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
softfac run [--once]               Process ready issues continuously, or once
softfac check-pr <number>          Enforce the PR policy (used by CI)
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

- Human review comments on a PR are not consumed; a blocked issue is resumed by re-labelling it.
- `review.maxRounds` counts extra rounds after the initial review.
- The architect sees the diff of the reviewed range, not the full repository.
- Verification commands run once, after the architecture gate; a failure blocks the issue
  instead of sending the output back to the implementer.
