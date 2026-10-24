import type {
  AgentRunner,
  BaseBranchSync,
  ArchitectInput,
  ArchitectResult,
  CreatePullRequestInput,
  GitOps,
  ImplementerInput,
  ImplementerResult,
  Issue,
  IssueTracker,
  PullRequest,
  ReviewInput,
  ReviewResult,
  StateStore,
  VerificationResult,
  VerifyInput,
} from "../../src/ports.js";
import { createInitialState, type FactoryState } from "../../src/state.js";

export class MemoryStateStore implements StateStore {
  state: FactoryState;

  constructor(initial: FactoryState = createInitialState()) {
    this.state = initial;
  }

  async read(): Promise<FactoryState> {
    return this.state;
  }

  async write(state: FactoryState): Promise<void> {
    this.state = state;
  }

  async update(
    mutator: (state: FactoryState) => FactoryState,
  ): Promise<FactoryState> {
    this.state = mutator(this.state);
    return this.state;
  }
}

export class FakeTracker implements IssueTracker {
  issues: Issue[];
  readonly claims: Issue[] = [];
  readonly requeues: number[] = [];
  onRequeue: (() => void) | undefined;
  readonly blocks: { issue: Issue; reason: string }[] = [];
  readonly comments: { issue: Issue; body: string }[] = [];
  readonly labels: { issue: Issue; labels: readonly string[] }[] = [];
  readonly unlabels: { issue: Issue; labels: readonly string[] }[] = [];
  readonly closes: { issue: Issue; comment?: string }[] = [];
  readonly pullRequests: CreatePullRequestInput[] = [];
  readonly merges: number[] = [];
  closeError: Error | undefined;
  readonly #prBase: number;

  constructor(issues: Issue[], prBase = 100) {
    this.issues = issues;
    this.#prBase = prBase;
  }

  async listReady(): Promise<Issue[]> {
    return this.issues;
  }

  async claim(issue: Issue): Promise<void> {
    this.claims.push(issue);
  }

  async requeue(issueNumber: number): Promise<void> {
    this.requeues.push(issueNumber);
    this.onRequeue?.();
  }

  async block(issue: Issue, reason: string): Promise<void> {
    this.blocks.push({ issue, reason });
  }

  async comment(issue: Issue, body: string): Promise<void> {
    this.comments.push({ issue, body });
  }

  async label(issue: Issue, labels: readonly string[]): Promise<void> {
    this.labels.push({ issue, labels });
  }

  async unlabel(issue: Issue, labels: readonly string[]): Promise<void> {
    this.unlabels.push({ issue, labels });
  }

  async close(issue: Issue, comment?: string): Promise<void> {
    this.closes.push(comment === undefined ? { issue } : { issue, comment });
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.pullRequests.push(input);
    return {
      number: this.#prBase + this.pullRequests.length,
      url: `https://example.test/pull/${this.#prBase + this.pullRequests.length}`,
    };
  }

  async mergePullRequest(prNumber: number): Promise<void> {
    this.merges.push(prNumber);
  }
}

export class FakeGit implements GitOps {
  baseSync: BaseBranchSync = {
    status: "up-to-date",
    sha: "base1234567890",
  };
  onSync: (() => void) | undefined;
  readonly baseSyncCalls: string[] = [];
  commitsSince = 0;
  head = "abcdef1234567890";
  baseHead = "base1234567890";
  ancestor = true;
  diffText = "diff --git a/file b/file";
  changedPaths: string[] = ["src/file.ts", "tests/file.test.ts"];
  changedPathRounds: string[][] = [];
  readonly countCalls: { branch: string; sinceSha: string | null }[] = [];
  readonly branches: string[] = [];
  readonly pushes: string[] = [];
  readonly files: {
    branch: string;
    path: string;
    content: string;
    message: string;
  }[] = [];
  readonly #prefix: string;
  readonly #baseBranch: string;

  constructor(prefix = "softfac/", baseBranch = "main") {
    this.#prefix = prefix;
    this.#baseBranch = baseBranch;
  }

  async prepareBranch(issue: Issue): Promise<string> {
    const branch = `${this.#prefix}${issue.number}`;
    this.branches.push(branch);
    return branch;
  }

  async fetchBaseBranch(branch: string): Promise<BaseBranchSync> {
    this.baseSyncCalls.push(branch);
    this.onSync?.();
    return this.baseSync;
  }

  async countCommits(branch: string, sinceSha: string | null): Promise<number> {
    this.countCalls.push({ branch, sinceSha });
    return this.commitsSince;
  }

  async headSha(branch: string): Promise<string> {
    return branch === this.#baseBranch ? this.baseHead : this.head;
  }

  async changedFiles(
    _branch: string,
    _sinceSha: string | null,
  ): Promise<string[]> {
    return this.changedPathRounds.shift() ?? [...this.changedPaths];
  }

  async isAncestor(_ancestor: string, _descendant: string): Promise<boolean> {
    return this.ancestor;
  }

  async diff(_branch: string, _sinceSha: string | null): Promise<string> {
    return this.diffText;
  }

  async push(branch: string): Promise<void> {
    this.pushes.push(branch);
  }

  async commitFile(
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    this.files.push({ branch, path, content, message });
  }
}

export class FakeAgents implements AgentRunner {
  readonly implementCalls: ImplementerInput[] = [];
  readonly reviewCalls: ReviewInput[] = [];
  readonly architectCalls: ArchitectInput[] = [];
  readonly verifyCalls: VerifyInput[] = [];
  readonly released: string[] = [];
  onVerify: (() => void) | undefined;
  verifyResults: VerificationResult[] = [];
  implementResults: ImplementerResult[] = [];
  reviewResults: ReviewResult[] = [];
  architectResults: ArchitectResult[] = [];
  implementError: Error | undefined;

  async implement(input: ImplementerInput): Promise<ImplementerResult> {
    this.implementCalls.push(input);
    if (this.implementError !== undefined) {
      throw this.implementError;
    }
    return (
      this.implementResults.shift() ?? {
        commits: 1,
        stdout: "implemented",
      }
    );
  }

  async releaseWorktree(branch: string): Promise<void> {
    this.released.push(branch);
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    this.verifyCalls.push(input);
    this.onVerify?.();
    return (
      this.verifyResults.shift() ?? {
        passed: true,
        results: input.commands.map((command) => ({
          command,
          exitCode: 0,
          output: "",
        })),
      }
    );
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    this.reviewCalls.push(input);
    return (
      this.reviewResults.shift() ?? {
        verdict: "approved",
        summary: "Looks good.",
        findings: [],
        commits: 0,
      }
    );
  }

  async architect(input: ArchitectInput): Promise<ArchitectResult> {
    this.architectCalls.push(input);
    return (
      this.architectResults.shift() ?? {
        verdict: {
          decision: "approved",
          summary: "Architecture is coherent.",
          followUps: [],
        },
        stdout: "<architecture></architecture>",
      }
    );
  }
}

export function issue(
  number: number,
  labels: readonly string[] = ["bug"],
): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    url: `https://example.test/issues/${number}`,
    labels,
  };
}
