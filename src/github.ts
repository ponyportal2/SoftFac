import { checkPullRequest } from "./check-pr.js";
import {
  ProcessRunner,
  type CommandRunner,
} from "./command.js";
import type { PolicyOptions, PolicyResult } from "./policy.js";
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  Issue,
  IssueTracker,
  PullRequest,
  PullRequestDiscussion,
  PullRequestFeedback,
} from "./ports.js";

export interface GitHubTrackerOptions {
  readonly repo: string;
  readonly baseBranch: string;
  readonly labels: {
    readonly ready: string;
    readonly running: string;
    readonly blocked: string;
  };
  readonly policy: PolicyOptions;
  readonly runner?: CommandRunner;
}

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly labels: readonly { readonly name: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePullRequests(output: string): PullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("gh pr list returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("gh pr list returned an invalid payload");
  }
  return parsed.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry["number"] !== "number" ||
      typeof entry["url"] !== "string"
    ) {
      throw new Error("gh pr list returned an invalid pull request");
    }
    return { number: entry["number"], url: entry["url"] };
  });
}

function parseIssue(value: unknown): Issue {
  if (
    !isRecord(value) ||
    typeof value["number"] !== "number" ||
    typeof value["title"] !== "string" ||
    typeof value["body"] !== "string" ||
    typeof value["url"] !== "string" ||
    !Array.isArray(value["labels"])
  ) {
    throw new Error("gh issue returned an invalid issue");
  }

  const labels = value["labels"].map((label: unknown) => {
    if (!isRecord(label) || typeof label["name"] !== "string") {
      throw new Error("gh issue returned an invalid label");
    }
    return label["name"];
  });

  return {
    number: value["number"],
    title: value["title"],
    body: value["body"],
    url: value["url"],
    labels,
  };
}

function parseDiscussionState(
  value: unknown,
): PullRequestDiscussion["state"] {
  if (value === "OPEN" || value === "MERGED" || value === "CLOSED") {
    return value;
  }
  throw new Error("gh pr view returned an invalid pull request state");
}

function parseFeedback(
  entries: unknown,
  kind: "review" | "comment",
): PullRequestFeedback[] {
  if (entries === undefined) {
    return [];
  }
  if (!Array.isArray(entries)) {
    throw new Error(`gh pr view returned invalid ${kind}s`);
  }

  const items: PullRequestFeedback[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      throw new Error(`gh pr view returned an invalid ${kind}`);
    }
    // Comments written by the factory itself (the authenticated gh user) are
    // status updates, not review feedback.
    if (entry["viewerDidAuthor"] === true) {
      continue;
    }
    if (kind === "review") {
      const state = entry["state"];
      // An approval is not a request to change anything, and a pending review
      // is not visible to the factory yet.
      if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") {
        continue;
      }
    }
    const id = entry["id"];
    const body = entry["body"];
    const author = entry["author"];
    const createdAt = kind === "review" ? entry["submittedAt"] : entry["createdAt"];
    if (
      typeof id !== "string" ||
      typeof body !== "string" ||
      !isRecord(author) ||
      typeof author["login"] !== "string" ||
      typeof createdAt !== "string"
    ) {
      throw new Error(`gh pr view returned an invalid ${kind}`);
    }
    if (body.trim() === "") {
      continue;
    }
    items.push({
      id: `${kind}:${id}`,
      author: author["login"],
      body: body.trim(),
      createdAt,
    });
  }
  return items;
}

function parsePullRequestDiscussion(output: string): PullRequestDiscussion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("gh pr view returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("gh pr view returned an invalid payload");
  }

  const feedback = [
    ...parseFeedback(parsed["reviews"], "review"),
    ...parseFeedback(parsed["comments"], "comment"),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return { state: parseDiscussionState(parsed["state"]), feedback };
}

export class GitHubTracker implements IssueTracker {
  readonly #repo: string;
  readonly #baseBranch: string;
  readonly #labels: GitHubTrackerOptions["labels"];
  readonly #policy: PolicyOptions;
  readonly #runner: CommandRunner;

  constructor(options: GitHubTrackerOptions) {
    this.#repo = options.repo;
    this.#baseBranch = options.baseBranch;
    this.#labels = options.labels;
    this.#policy = options.policy;
    this.#runner = options.runner ?? new ProcessRunner();
  }

  async #gh(args: readonly string[]): Promise<string> {
    const result = await this.#runner.run("gh", args);
    return result.stdout;
  }

  async listReady(): Promise<Issue[]> {
    const output = await this.#gh([
      "issue",
      "list",
      "--repo",
      this.#repo,
      "--state",
      "open",
      "--label",
      this.#labels.ready,
      "--json",
      "number,title,body,url,labels",
      "--limit",
      "100",
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error("gh issue list returned invalid JSON", { cause: error });
    }
    if (!Array.isArray(parsed)) {
      throw new Error("gh issue list returned a non-array payload");
    }
    return parsed.map(parseIssue);
  }

  async getIssue(issueNumber: number): Promise<Issue> {
    const output = await this.#gh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      this.#repo,
      "--json",
      "number,title,body,url,labels",
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      throw new Error("gh issue view returned invalid JSON", { cause: error });
    }
    return parseIssue(parsed);
  }

  async claim(issue: Issue): Promise<void> {
    await this.#gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      this.#repo,
      "--add-label",
      this.#labels.running,
      "--remove-label",
      this.#labels.ready,
    ]);
  }

  async requeue(issueNumber: number): Promise<void> {
    await this.#gh([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      this.#repo,
      "--add-label",
      this.#labels.ready,
      "--remove-label",
      this.#labels.running,
    ]);
  }

  async block(issue: Issue, reason: string): Promise<void> {
    await this.comment(issue, reason);
    await this.#gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      this.#repo,
      "--add-label",
      this.#labels.blocked,
      "--remove-label",
      this.#labels.running,
    ]);
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.#gh([
      "issue",
      "comment",
      String(issue.number),
      "--repo",
      this.#repo,
      "--body",
      body,
    ]);
  }

  async label(issue: Issue, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.#gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      this.#repo,
      "--add-label",
      labels.join(","),
    ]);
  }

  async unlabel(issue: Issue, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.#gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      this.#repo,
      "--remove-label",
      labels.join(","),
    ]);
  }

  async close(issue: Issue, comment?: string): Promise<void> {
    const args = [
      "issue",
      "close",
      String(issue.number),
      "--repo",
      this.#repo,
    ];
    if (comment !== undefined) {
      args.push("--comment", comment);
    }
    await this.#gh(args);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const args = [
      "issue",
      "create",
      "--repo",
      this.#repo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.labels.length > 0) {
      args.push("--label", input.labels.join(","));
    }
    const url = (await this.#gh(args)).trim();
    const match = /(\d+)\s*$/.exec(url);
    if (match?.[1] === undefined) {
      throw new Error(`could not parse issue number from gh output: ${url}`);
    }
    return {
      number: Number(match[1]),
      title: input.title,
      body: input.body,
      url,
      labels: input.labels,
    };
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const existing = parsePullRequests(
      await this.#gh([
        "pr",
        "list",
        "--repo",
        this.#repo,
        "--head",
        input.branch,
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ]),
    );
    const [open] = existing;
    if (open !== undefined) {
      // The branch survived a crash, but its PR body still describes the
      // previous review. Refresh it before returning the same PR.
      await this.#gh([
        "pr",
        "edit",
        String(open.number),
        "--repo",
        this.#repo,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      return open;
    }

    const output = await this.#gh([
      "pr",
      "create",
      "--repo",
      this.#repo,
      "--base",
      this.#baseBranch,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body",
      input.body,
    ]);
    const url = output.trim();
    const match = /(\d+)\s*$/.exec(url);
    if (match?.[1] === undefined) {
      throw new Error(`could not parse PR number from gh output: ${url}`);
    }
    return { number: Number(match[1]), url };
  }

  async pullRequestDiscussion(
    prNumber: number,
  ): Promise<PullRequestDiscussion> {
    const output = await this.#gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.#repo,
      "--json",
      "state,reviews,comments",
    ]);
    return parsePullRequestDiscussion(output);
  }

  async pullRequestPolicy(prNumber: number): Promise<PolicyResult> {
    const result = await checkPullRequest({
      repo: this.#repo,
      prNumber,
      policy: this.#policy,
      runner: this.#runner,
    });
    return { ok: result.ok, violations: result.violations };
  }

  async mergePullRequest(prNumber: number): Promise<void> {
    await this.#gh([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      this.#repo,
      "--squash",
      "--delete-branch",
    ]);
  }
}
