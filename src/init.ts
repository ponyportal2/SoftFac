import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultConfig } from "./config.js";

export interface InitRepoOptions {
  readonly repoPath: string;
  readonly repo: string;
}

const IMPLEMENTER_PROMPT = `You are SoftFac's implementer for issue #{{ISSUE_NUMBER}}.

Issue: {{ISSUE_TITLE}}
URL: {{ISSUE_URL}}
Labels: {{ISSUE_LABELS}}
Branch: {{BRANCH}}
Base branch: {{BASE_BRANCH}}

Issue body:

{{ISSUE_BODY}}

Previous review feedback:

{{REVIEW_FEEDBACK}}

Rules:
- Work test-first: write or update a failing test before the fix.
- Keep the change focused on the issue and preserve existing behavior.
- Run the project's tests and any documented checks before you finish.
- For a bug, change at least one test file with a regression test that fails
  without the fix; the factory rejects a bug branch with no test changes.
- Commit your work on {{BRANCH}}. Do not merge, close the issue, or open a PR.
- Never stop processes you did not start. The factory, this session, and the verifier are all
  node processes; killing one by PID aborts the run. Undo stray build artifacts with
  \`git restore\` instead of hunting for processes.
- Do not edit \`docs/architecture/reviews\`; those are written by the architect.
- The branch history is append-only. Never rebase, amend, reset, or force-rewrite a
  commit you did not write in this session, including \`arch: review ...\` commits from
  the architect. Add new commits instead; if an earlier commit looks wrong, say so in
  your final message and stop. The factory rejects a branch that no longer contains
  the head it handed you.
- Do not use closing keywords in commit messages.
- When the work is complete and verified, print <promise>COMPLETE</promise>.
`;

const REVIEWER_PROMPT = `You are SoftFac's permanent reviewer.

Review issue #{{ISSUE_NUMBER}} on branch {{BRANCH}} against {{BASE_BRANCH}}.
Issue: {{ISSUE_TITLE}}
URL: {{ISSUE_URL}}
Issue body:

{{ISSUE_BODY}}

Use git to inspect the branch diff against {{BASE_BRANCH}}. Verify:
- correctness and edge cases
- tests actually cover the behavior, especially regression tests
- unnecessary scope, security, and maintainability problems
- whether the implementation answers the issue

Be strict but do not invent requirements. If changes are required, list
specific, actionable findings. Your final answer must contain exactly one
block in this form:

<review>
{"verdict":"approved","summary":"one sentence","findings":[]}
</review>

Use verdict "changes_requested" and list findings when work is incomplete.
`;

const ARCHITECT_PROMPT = `You are SoftFac's architect. Review the architecture of the
change for issue #{{ISSUE_NUMBER}}, not its line-level style.

Issue: {{ISSUE_TITLE}}
Branch: {{BRANCH}}
Range: {{FROM_SHA}}..{{TO_SHA}}
Commits: {{COMMITS}}

The range starts at the last architecture review anchor on the base branch,
so it includes work merged since that review as well as this branch.

Prior architecture decisions (newest first):
{{PRIOR_DECISIONS}}

Repository context (tracked files, architecture docs, dependency manifests, coverage):
{{REPOSITORY_CONTEXT}}

Keep new decisions consistent with the prior ones. If you reverse a prior
decision, explain why in the summary.

Diff:

{{DIFF}}

Check for boundary violations, hidden coupling, unnecessary abstractions,
data-model mistakes, migration risks, and missing architectural tests.
Do not modify code or tests. Your final answer must contain exactly one block:

<architecture>
{"decision":"approved","summary":"one sentence","followUps":[]}
</architecture>

Use decision "changes_requested" when the design must change before merge.
`;

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

const GITIGNORE_ENTRIES = [
  ".softfac/state.json",
  ".softfac/state.json.tmp",
  ".softfac/run.lock",
  ".softfac/logs/",
  ".softfac/worktrees/",
  ".sandcastle/",
] as const;

async function ensureGitignore(repoPath: string): Promise<void> {
  const path = join(repoPath, ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // The file does not exist yet; create it below.
  }

  const lines = current.split(/\r?\n/);
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return;
  }

  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(path, `${prefix}${missing.join("\n")}\n`, "utf8");
}

export async function initRepo(options: InitRepoOptions): Promise<void> {
  const softfac = join(options.repoPath, ".softfac");
  await mkdir(join(softfac, "prompts"), { recursive: true });
  await mkdir(join(softfac, "logs"), { recursive: true });
  await mkdir(join(options.repoPath, "docs", "architecture", "reviews"), {
    recursive: true,
  });

  const config = defaultConfig();
  const serialized = {
    ...config,
    repo: options.repo.trim() === "" ? "OWNER/REPO" : options.repo.trim(),
  };
  await writeIfMissing(
    join(softfac, "config.json"),
    `${JSON.stringify(serialized, null, 2)}\n`,
  );
  await writeIfMissing(
    join(softfac, "prompts", "implementer.md"),
    IMPLEMENTER_PROMPT,
  );
  await writeIfMissing(
    join(softfac, "prompts", "reviewer.md"),
    REVIEWER_PROMPT,
  );
  await writeIfMissing(
    join(softfac, "prompts", "architect.md"),
    ARCHITECT_PROMPT,
  );
  await ensureGitignore(options.repoPath);
}
