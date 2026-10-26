import {
  ProcessRunner,
  type CommandRunner,
} from "./command.js";
import { parseIssueReference } from "./issue-reference.js";
import {
  validatePullRequest,
  type PolicyOptions,
  type PolicyResult,
  type PolicyViolation,
} from "./policy.js";

export interface RepairOptions {
  /** Only branches created by the factory may reopen an issue. */
  readonly branchPrefix: string;
  /** The issue must still carry one of the factory's labels. */
  readonly managedLabels: readonly string[];
}

export interface CheckPullRequestOptions {
  readonly repo: string;
  readonly prNumber: number;
  readonly policy: PolicyOptions;
  readonly runner?: CommandRunner;
  readonly repair?: RepairOptions;
}

export interface CheckPullRequestResult extends PolicyResult {
  readonly issueNumber: number;
  readonly architectureApproved: boolean;
  readonly issueState: "OPEN" | "CLOSED";
  readonly reopened: boolean;
  readonly violations: PolicyViolation[];
}

interface PullRequestPayload {
  readonly body: string;
  readonly labels: readonly string[];
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(output: string, context: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

function parseLabels(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} labels must be an array`);
  }
  return value.map((label) => {
    if (!isRecord(label) || typeof label["name"] !== "string") {
      throw new Error(`${context} returned an invalid label`);
    }
    return label["name"];
  });
}

function parsePullRequest(value: unknown): PullRequestPayload {
  if (!isRecord(value)) {
    throw new Error("gh pr view returned an invalid payload");
  }
  if (typeof value["body"] !== "string") {
    throw new Error("gh pr view returned an invalid body");
  }
  const headRefName = value["headRefName"];
  const isCrossRepository = value["isCrossRepository"];
  if (
    typeof headRefName !== "string" ||
    typeof isCrossRepository !== "boolean"
  ) {
    throw new Error("gh pr view returned an invalid head");
  }
  return {
    body: value["body"],
    labels: parseLabels(value["labels"] ?? [], "gh pr view"),
    headRefName,
    isCrossRepository,
  };
}

function parseIssueState(value: unknown): "OPEN" | "CLOSED" {
  if (value === undefined) {
    return "OPEN";
  }
  if (value === "OPEN" || value === "CLOSED") {
    return value;
  }
  throw new Error("gh issue view returned an invalid state");
}

export async function checkPullRequest(
  options: CheckPullRequestOptions,
): Promise<CheckPullRequestResult> {
  const runner = options.runner ?? new ProcessRunner();

  const prOutput = await runner.run("gh", [
    "pr",
    "view",
    String(options.prNumber),
    "--repo",
    options.repo,
    "--json",
    "body,labels,headRefName,isCrossRepository",
  ]);
  const pr = parsePullRequest(parseJson(prOutput.stdout, "gh pr view"));

  const issueNumber = parseIssueReference(pr.body);
  if (issueNumber === undefined) {
    throw new Error(
      'the PR body must reference an issue with "Fixes #N" or "Part of #N".',
    );
  }

  const issueOutput = await runner.run("gh", [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    options.repo,
    "--json",
    "labels,state",
  ]);
  const issuePayload = parseJson(issueOutput.stdout, "gh issue view");
  if (!isRecord(issuePayload)) {
    throw new Error("gh issue view returned an invalid payload");
  }
  const issueLabels = parseLabels(
    issuePayload["labels"] ?? [],
    "gh issue view",
  );
  const issueState = parseIssueState(issuePayload["state"]);

  const architectureApproved = [...pr.labels, ...issueLabels].includes(
    "arch:approved",
  );
  const result = validatePullRequest({
    body: pr.body,
    labels: pr.labels,
    issue: { number: issueNumber, labels: issueLabels },
    architectureApproved,
    policy: options.policy,
  });

  const repair = options.repair;
  const repairAllowed =
    repair !== undefined &&
    !pr.isCrossRepository &&
    pr.headRefName.startsWith(repair.branchPrefix) &&
    issueLabels.some((label) => repair.managedLabels.includes(label));
  const reopened =
    repairAllowed && issueState === "CLOSED" && !result.ok;
  if (reopened) {
    await runner.run("gh", [
      "issue",
      "reopen",
      String(issueNumber),
      "--repo",
      options.repo,
    ]);
  }

  return {
    ...result,
    issueNumber,
    architectureApproved,
    issueState,
    reopened,
  };
}
