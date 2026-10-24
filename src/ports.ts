import type {
  ArchitectureDecisionRecord,
  ArchitectureVerdict,
} from "./architecture.js";
import type { FactoryState } from "./state.js";

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly labels: readonly string[];
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
}

export interface ImplementerInput {
  readonly issue: Issue;
  readonly branch: string;
  readonly sessionId?: string;
  readonly feedback?: ReviewResult;
}

export interface ImplementerResult {
  readonly sessionId?: string;
  readonly commits: number;
  readonly stdout: string;
}

export interface ReviewInput {
  readonly issue: Issue;
  readonly branch: string;
  readonly sessionId?: string;
  readonly implementerSessionId?: string;
}

export interface ReviewResult {
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
  readonly findings: readonly string[];
  readonly sessionId?: string;
  readonly commits: number;
}

export interface ArchitectInput {
  readonly issue: Issue;
  readonly branch: string;
  readonly fromSha: string | null;
  readonly toSha: string;
  readonly commits: number;
  readonly diff: string;
  readonly priorDecisions: readonly ArchitectureDecisionRecord[];
}

export interface ArchitectResult {
  readonly verdict: ArchitectureVerdict;
  readonly stdout: string;
}

export interface VerifyInput {
  readonly branch: string;
  readonly commands: readonly string[];
}

export interface VerificationCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly results: readonly VerificationCommandResult[];
}

export interface AgentRunner {
  releaseWorktree(branch: string): Promise<void>;
  verify(input: VerifyInput): Promise<VerificationResult>;
  implement(input: ImplementerInput): Promise<ImplementerResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
  architect(input: ArchitectInput): Promise<ArchitectResult>;
}

export interface CreatePullRequestInput {
  readonly issue: Issue;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

export interface IssueTracker {
  listReady(): Promise<Issue[]>;
  claim(issue: Issue): Promise<void>;
  requeue(issueNumber: number): Promise<void>;
  block(issue: Issue, reason: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  label(issue: Issue, labels: readonly string[]): Promise<void>;
  unlabel(issue: Issue, labels: readonly string[]): Promise<void>;
  close(issue: Issue, comment?: string): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  mergePullRequest(prNumber: number): Promise<void>;
}

export type BaseBranchSync =
  | { readonly status: "updated"; readonly from: string; readonly to: string }
  | { readonly status: "up-to-date"; readonly sha: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface GitOps {
  prepareBranch(issue: Issue): Promise<string>;
  fetchBaseBranch(branch: string): Promise<BaseBranchSync>;
  countCommits(branch: string, sinceSha: string | null): Promise<number>;
  headSha(branch: string): Promise<string>;
  diff(branch: string, sinceSha: string | null): Promise<string>;
  changedFiles(branch: string, sinceSha: string | null): Promise<string[]>;
  isAncestor(ancestorSha: string, branch: string): Promise<boolean>;
  push(branch: string): Promise<void>;
  commitFile(
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void>;
}

export interface StateStore {
  read(): Promise<FactoryState>;
  write(state: FactoryState): Promise<void>;
  update(mutator: (state: FactoryState) => FactoryState): Promise<FactoryState>;
}

export interface FactoryLogger {
  info(message: string): void;
  warn(message: string): void;
}
