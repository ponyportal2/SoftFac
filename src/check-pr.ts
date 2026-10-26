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
import { isTrustedApprover } from "./trust.js";

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
  readonly trustedAuthors?: readonly string[];
  readonly repair?: RepairOptions;
}

export interface CheckPullRequestResult extends PolicyResult {
  readonly issueNumber: number;
  readonly humanApprovals: number;
  readonly architectureApproved: boolean;
  readonly issueState: "OPEN" | "CLOSED";
  readonly reopened: boolean;
  readonly violations: PolicyViolation[];
}

interface PullRequestPayload {
  readonly body: string;
  readonly labels: readonly string[];
  readonly reviews: readonly unknown[];
  readonly headRefOid: string;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
}

interface ParsedReview {
  readonly author: string;
  readonly association: string | undefined;
  readonly state: string;
  readonly commit: string | undefined;
  readonly submittedAt: string;
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
  const reviews = value["reviews"] ?? [];
  if (!Array.isArray(reviews)) {
    throw new Error("gh pr view returned invalid reviews");
  }
  const headRefOid = value["headRefOid"];
  const headRefName = value["headRefName"];
  const isCrossRepository = value["isCrossRepository"];
  if (
    typeof headRefOid !== "string" ||
    typeof headRefName !== "string" ||
    typeof isCrossRepository !== "boolean"
  ) {
    throw new Error("gh pr view returned an invalid head");
  }
  return {
    body: value["body"],
    labels: parseLabels(value["labels"] ?? [], "gh pr view"),
    reviews,
    headRefOid,
    headRefName,
    isCrossRepository,
  };
}

function isBot(login: string): boolean {
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]") || normalized === "github-actions";
}

function parseReviews(reviews: readonly unknown[]): ParsedReview[] {
  const parsed: ParsedReview[] = [];
  for (const review of reviews) {
    if (!isRecord(review) || typeof review["state"] !== "string") {
      continue;
    }
    const author = review["author"];
    if (!isRecord(author) || typeof author["login"] !== "string") {
      continue;
    }
    const association = review["authorAssociation"];
    const commit = review["commit"];
    const submittedAt = review["submittedAt"];
    parsed.push({
      author: author["login"],
      association: typeof association === "string" ? association : undefined,
      state: review["state"],
      commit:
        isRecord(commit) && typeof commit["oid"] === "string"
          ? commit["oid"]
          : undefined,
      submittedAt: typeof submittedAt === "string" ? submittedAt : "",
    });
  }
  return parsed;
}

const DECISIVE_REVIEW_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);

/**
 * GitHub keeps every review in the list, so an approval followed by a
 * change request would otherwise still count. Only the newest decisive
 * review from each author matters. A COMMENTED review neither approves nor
 * withdraws, so it does not erase an earlier decision.
 */
function latestDecisiveReviewsByAuthor(
  reviews: readonly ParsedReview[],
): ParsedReview[] {
  const latest = new Map<string, ParsedReview>();
  for (const review of reviews) {
    if (!DECISIVE_REVIEW_STATES.has(review.state)) {
      continue;
    }
    const key = review.author.toLowerCase();
    const current = latest.get(key);
    if (current === undefined || review.submittedAt >= current.submittedAt) {
      latest.set(key, review);
    }
  }
  return [...latest.values()];
}

function humanApprovals(
  reviews: readonly ParsedReview[],
  headRefOid: string,
  trustedAuthors: readonly string[],
): number {
  let approvals = 0;
  for (const review of latestDecisiveReviewsByAuthor(reviews)) {
    if (
      review.state !== "APPROVED" ||
      review.commit !== headRefOid ||
      isBot(review.author)
    ) {
      continue;
    }
    if (
      !isTrustedApprover(review.author, review.association, { trustedAuthors })
    ) {
      continue;
    }
    approvals += 1;
  }
  return approvals;
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
  const trustedAuthors = options.trustedAuthors ?? [];

  const prOutput = await runner.run("gh", [
    "pr",
    "view",
    String(options.prNumber),
    "--repo",
    options.repo,
    "--json",
    "number,body,labels,reviews,headRefOid,headRefName,isCrossRepository",
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

  const approvals = humanApprovals(
    parseReviews(pr.reviews),
    pr.headRefOid,
    trustedAuthors,
  );
  const architectureApproved = [...pr.labels, ...issueLabels].includes(
    "arch:approved",
  );
  const result = validatePullRequest({
    body: pr.body,
    labels: pr.labels,
    issue: { number: issueNumber, labels: issueLabels },
    approvals: {
      human: approvals,
      architecture: architectureApproved,
    },
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
    humanApprovals: approvals,
    architectureApproved,
    issueState,
    reopened,
  };
}
