import {
  architectureReviewPath,
  decisionLabel,
  shouldRunArchitectureReview,
  truncateDiff,
  type ArchitectureVerdict,
} from "./architecture.js";
import { issuePolicy, type FactoryConfig } from "./config.js";
import {
  classifyIssue,
  type IssueKind,
} from "./policy.js";
import { buildPullRequestBody } from "./pr.js";
import type {
  AgentRunner,
  ArchitectResult,
  FactoryLogger,
  GitOps,
  ImplementerInput,
  Issue,
  IssueTracker,
  ReviewInput,
  ReviewResult,
  StateStore,
} from "./ports.js";
import { rememberSession, resolveSession } from "./sessions.js";
import {
  rememberArchitectureDecision,
  type FactoryState,
  type IssueRecord,
  type IssueStatus,
} from "./state.js";
import { hasTestEvidence } from "./test-evidence.js";

export type ProcessOutcome = "done" | "pull-request" | "blocked" | "failed";
export type ArchitectureGateStatus =
  | "skipped"
  | "approved"
  | "changes_requested";

export interface ProcessResult {
  readonly issueNumber: number;
  readonly kind: IssueKind;
  readonly outcome: ProcessOutcome;
  readonly branch: string;
  readonly reviewRounds: number;
  readonly architecture: ArchitectureGateStatus;
  readonly prNumber?: number;
  readonly reason?: string;
}

export interface FactoryDeps {
  readonly config: FactoryConfig;
  readonly tracker: IssueTracker;
  readonly git: GitOps;
  readonly agents: AgentRunner;
  readonly state: StateStore;
  readonly now?: () => Date;
  readonly logger?: FactoryLogger;
}

interface GateResult {
  readonly status: ArchitectureGateStatus;
  readonly summary?: string;
}

const VERIFICATION_OUTPUT_LINES = 20;
const VERIFICATION_OUTPUT_CHARS = 2000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputTail(output: string): string {
  const lines = output.trimEnd().split(/\r?\n/);
  const tail = lines.slice(-VERIFICATION_OUTPUT_LINES).join("\n");
  return tail.length > VERIFICATION_OUTPUT_CHARS
    ? tail.slice(-VERIFICATION_OUTPUT_CHARS)
    : tail;
}

export class Factory {
  readonly #config: FactoryConfig;
  readonly #tracker: IssueTracker;
  readonly #git: GitOps;
  readonly #agents: AgentRunner;
  readonly #state: StateStore;
  readonly #now: () => Date;
  readonly #logger: FactoryLogger | undefined;
  #recovered = false;

  constructor(deps: FactoryDeps) {
    this.#config = deps.config;
    this.#tracker = deps.tracker;
    this.#git = deps.git;
    this.#agents = deps.agents;
    this.#state = deps.state;
    this.#now = deps.now ?? (() => new Date());
    this.#logger = deps.logger;
  }

  async recoverInterrupted(): Promise<number> {
    const state = await this.#state.read();
    const stale = Object.values(state.issues).filter(
      (record) =>
        record.status === "running" ||
        record.status === "reviewing" ||
        record.status === "architecture",
    );
    if (stale.length === 0) {
      return 0;
    }

    for (const record of stale) {
      await this.#tracker.requeue(record.number);
      this.#logger?.info(
        `issue #${record.number}: requeued after an interrupted ${record.status} run`,
      );
    }

    const updatedAt = this.#now().toISOString();
    await this.#state.update((current) => {
      const issues = { ...current.issues };
      for (const record of stale) {
        issues[String(record.number)] = {
          ...record,
          status: "pending",
          updatedAt,
        };
      }
      return { ...current, issues, updatedAt };
    });

    return stale.length;
  }

  async runOnce(): Promise<ProcessResult[]> {
    if (!this.#recovered) {
      await this.recoverInterrupted();
      this.#recovered = true;
    }
    const issues = await this.#tracker.listReady();
    const selected = issues.slice(0, this.#config.maxIssuesPerRun);
    const results: ProcessResult[] = [];

    for (const issue of selected) {
      try {
        results.push(await this.processIssue(issue));
      } catch (error) {
        const reason = errorMessage(error);
        const kind = classifyIssue(issue.labels, issuePolicy(this.#config));
        const branch = `${this.#config.branchPrefix}${issue.number}`;
        this.#logger?.warn(`issue #${issue.number} failed: ${reason}`);
        try {
          await this.#tracker.block(issue, `SoftFac failed: ${reason}`);
        } catch (blockError) {
          this.#logger?.warn(
            `could not block issue #${issue.number}: ${errorMessage(blockError)}`,
          );
        }
        await this.#setIssue(issue, kind, branch, "failed", {
          lastError: reason,
        });
        results.push({
          issueNumber: issue.number,
          kind,
          outcome: "failed",
          branch,
          reviewRounds: 0,
          architecture: "skipped",
          reason,
        });
      }
    }

    return results;
  }

  async processIssue(issue: Issue): Promise<ProcessResult> {
    const kind = classifyIssue(issue.labels, issuePolicy(this.#config));
    const sync = await this.#git.fetchBaseBranch(this.#config.baseBranch);
    if (sync.status === "updated") {
      this.#logger?.info(
        `base branch ${this.#config.baseBranch}: ` +
          `${sync.from.slice(0, 7)}..${sync.to.slice(0, 7)}`,
      );
    } else if (sync.status === "skipped") {
      this.#logger?.warn(`base branch not synced: ${sync.reason}`);
    }
    const branch = await this.#git.prepareBranch(issue);
    try {
      return await this.#runIssue(issue, kind, branch);
    } finally {
      try {
        await this.#agents.releaseWorktree(branch);
      } catch (error) {
        this.#logger?.warn(
          `issue #${issue.number}: could not release the worktree for ` +
            `${branch}: ${errorMessage(error)}`,
        );
      }
    }
  }

  async #runIssue(
    issue: Issue,
    kind: IssueKind,
    branch: string,
  ): Promise<ProcessResult> {
    this.#logger?.info(`issue #${issue.number} (${kind}) on ${branch}`);
    await this.#tracker.claim(issue);
    await this.#setIssue(issue, kind, branch, "running");

    let implementerSession = await this.#session("implementer", issue.number);
    let implementation = await this.#agents.implement(
      this.#implementerInput(issue, branch, implementerSession),
    );
    await this.#remember("implementer", issue.number, implementation.sessionId);

    if (implementation.commits <= 0) {
      return this.#block(
        issue,
        kind,
        branch,
        `Implementer produced no commits on ${branch}.`,
      );
    }

    await this.#setIssue(issue, kind, branch, "reviewing");
    let reviewerSession = await this.#session("reviewer", issue.number);
    let review = await this.#agents.review(
      this.#reviewerInput(issue, branch, reviewerSession, implementation.sessionId),
    );
    await this.#remember("reviewer", issue.number, review.sessionId);
    reviewerSession = review.sessionId ?? reviewerSession;

    let totalRounds = 1;
    let extraRounds = 0;

    while (true) {
      if (review.verdict === "approved") {
        const missingTests = await this.#missingTestEvidence(kind, branch);
        if (missingTests === undefined) {
          break;
        }
        review = missingTests;
      }

      if (extraRounds >= this.#config.review.maxRounds) {
        break;
      }

      extraRounds += 1;
      totalRounds += 1;
      this.#logger?.info(
        `issue #${issue.number}: applying review round ${totalRounds}`,
      );

      implementation = await this.#agents.implement(
        this.#implementerInput(
          issue,
          branch,
          implementation.sessionId ?? implementerSession,
          review,
        ),
      );
      await this.#remember("implementer", issue.number, implementation.sessionId);
      implementerSession = implementation.sessionId ?? implementerSession;

      if (implementation.commits <= 0) {
        return this.#block(
          issue,
          kind,
          branch,
          `Implementer produced no commits after review round ${totalRounds}.`,
          { reviewRounds: totalRounds },
        );
      }

      review = await this.#agents.review(
        this.#reviewerInput(
          issue,
          branch,
          reviewerSession,
          implementation.sessionId,
        ),
      );
      await this.#remember("reviewer", issue.number, review.sessionId);
      reviewerSession = review.sessionId ?? reviewerSession;
    }

    if (review.verdict === "changes_requested") {
      return this.#block(
        issue,
        kind,
        branch,
        `Review requested changes after ${totalRounds} rounds: ${review.summary}\n${review.findings.map((finding) => `- ${finding}`).join("\n")}`,
        { reviewRounds: totalRounds },
      );
    }

    await this.#setIssue(issue, kind, branch, "architecture");
    const gate = await this.#architectureGate(issue, kind, branch);
    if (gate.status === "changes_requested") {
      return this.#block(
        issue,
        kind,
        branch,
        `Architecture review requested changes: ${gate.summary ?? "see review"}`,
        { reviewRounds: totalRounds, architecture: "changes_requested" },
      );
    }

    const verificationFailure = await this.#verify(branch);
    if (verificationFailure !== undefined) {
      return this.#block(issue, kind, branch, verificationFailure, {
        reviewRounds: totalRounds,
        architecture: gate.status,
      });
    }

    await this.#git.push(branch);

    const body = buildPullRequestBody({
      kind,
      issue,
      branch,
      reviewSummary: review.summary,
      verification: this.#config.verification.commands,
      ...(gate.summary === undefined
        ? {}
        : { architectureSummary: gate.summary }),
      findings: review.findings,
    });
    const pr = await this.#tracker.createPullRequest({
      issue,
      branch,
      title: this.#pullRequestTitle(kind, issue),
      body,
    });
    await this.#setIssue(issue, kind, branch, "pull-request", {
      prNumber: pr.number,
    });
    this.#logger?.info(`issue #${issue.number}: opened PR #${pr.number}`);

    if (kind === "bug" && this.#config.bugs.autoMerge) {
      await this.#tracker.mergePullRequest(pr.number);
      if (this.#config.bugs.autoClose) {
        try {
          await this.#tracker.close(issue, `Fixed in #${pr.number}.`);
        } catch (error) {
          this.#logger?.warn(
            `issue #${issue.number} may already be closed by PR #${pr.number}: ${errorMessage(error)}`,
          );
        }
      }
      await this.#tracker.unlabel(issue, [this.#config.labels.running]);
      await this.#setIssue(issue, kind, branch, "done", {
        prNumber: pr.number,
      });
      return {
        issueNumber: issue.number,
        kind,
        outcome: "done",
        branch,
        reviewRounds: totalRounds,
        architecture: gate.status,
        prNumber: pr.number,
      };
    }

    await this.#tracker.unlabel(issue, [this.#config.labels.running]);
    await this.#tracker.label(issue, [this.#config.labels.needsHuman]);
    await this.#tracker.comment(
      issue,
      `PR #${pr.number} is ready for human review.`,
    );
    return {
      issueNumber: issue.number,
      kind,
      outcome: "pull-request",
      branch,
      reviewRounds: totalRounds,
      architecture: gate.status,
      prNumber: pr.number,
    };
  }

  async #architectureGate(
    issue: Issue,
    kind: IssueKind,
    branch: string,
  ): Promise<GateResult> {
    const state = await this.#state.read();
    const anchor = state.architecture.lastReviewedBaseSha;
    const since =
      anchor !== null && (await this.#git.isAncestor(anchor, branch))
        ? anchor
        : null;
    const commits = await this.#git.countCommits(branch, since);
    const forced =
      kind === "substantial" &&
      this.#config.architecture.requireForSubstantial;
    const due = shouldRunArchitectureReview({
      commitsSinceReview: commits,
      interval: this.#config.architecture.everyCommits,
    });

    if (!forced && !due) {
      return { status: "skipped" };
    }

    const toSha = await this.#git.headSha(branch);
    const baseSha = await this.#git.headSha(this.#config.baseBranch);
    const diff = truncateDiff(
      await this.#git.diff(branch, since),
      this.#config.architecture.maxDiffChars,
    );
    const result: ArchitectResult = await this.#agents.architect({
      issue,
      branch,
      fromSha: since,
      toSha,
      commits,
      diff,
      priorDecisions: state.architecture.decisions,
    });

    const path = architectureReviewPath({ date: this.#now(), sha: toSha });
    await this.#git.commitFile(
      branch,
      path,
      this.#architectureReviewMarkdown(result.verdict, {
        branch,
        fromSha: since,
        toSha,
        commits,
      }),
      `arch: review ${toSha.slice(0, 7)}`,
    );
    await this.#tracker.unlabel(issue, [
      decisionLabel(
        result.verdict.decision === "approved"
          ? "changes_requested"
          : "approved",
      ),
    ]);
    await this.#tracker.label(issue, [
      decisionLabel(result.verdict.decision),
    ]);
    const reviewedAt = this.#now().toISOString();
    await this.#state.update((current) => ({
      ...rememberArchitectureDecision(current, {
        branch,
        fromSha: since,
        toSha,
        anchorSha: baseSha,
        decision: result.verdict.decision,
        summary: result.verdict.summary,
        followUps: result.verdict.followUps,
        reviewedAt,
      }),
      updatedAt: reviewedAt,
    }));

    return {
      status: result.verdict.decision,
      summary: result.verdict.summary,
    };
  }

  #architectureReviewMarkdown(
    verdict: ArchitectureVerdict,
    range: {
      readonly branch: string;
      readonly fromSha: string | null;
      readonly toSha: string;
      readonly commits: number;
    },
  ): string {
    const lines = [
      "# Architecture review",
      "",
      `- Decision: ${verdict.decision}`,
      `- Branch: \`${range.branch}\``,
      `- Range: \`${range.fromSha ?? "initial"}..${range.toSha}\``,
      `- Commits reviewed: ${range.commits}`,
      "",
      "## Summary",
      verdict.summary,
    ];

    if (verdict.followUps.length > 0) {
      lines.push("", "## Follow-ups");
      for (const followUp of verdict.followUps) {
        lines.push(`- ${followUp}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  async #verify(branch: string): Promise<string | undefined> {
    const commands = this.#config.verification.commands;
    if (commands.length === 0) {
      return undefined;
    }

    const result = await this.#agents.verify({ branch, commands });
    if (result.passed) {
      return undefined;
    }

    const failed = result.results.at(-1);
    if (failed === undefined) {
      return "Verification failed without reporting a command.";
    }

    const output = outputTail(failed.output);
    return [
      `Verification failed: \`${failed.command}\` exited with ${failed.exitCode}.`,
      ...(output === "" ? [] : ["", output]),
    ].join("\n");
  }

  async #missingTestEvidence(
    kind: IssueKind,
    branch: string,
  ): Promise<ReviewResult | undefined> {
    if (kind !== "bug") {
      return undefined;
    }

    const changed = await this.#git.changedFiles(branch, null);
    if (hasTestEvidence(changed, this.#config.tdd.testPatterns)) {
      return undefined;
    }

    return {
      verdict: "changes_requested",
      summary:
        "No test file was changed for this bug fix. Add a regression test that fails without the fix.",
      findings: [
        "Add or update a regression test that fails before the fix and passes after it.",
        `Test files are detected with these patterns: ${this.#config.tdd.testPatterns.join(", ")}.`,
      ],
      commits: 0,
    };
  }

  #implementerInput(
    issue: Issue,
    branch: string,
    sessionId: string | undefined,
    feedback?: ReviewResult,
  ): ImplementerInput {
    return {
      issue,
      branch,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(feedback === undefined ? {} : { feedback }),
    };
  }

  #reviewerInput(
    issue: Issue,
    branch: string,
    sessionId: string | undefined,
    implementerSessionId: string | undefined,
  ): ReviewInput {
    return {
      issue,
      branch,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(implementerSessionId === undefined ? {} : { implementerSessionId }),
    };
  }

  #pullRequestTitle(kind: IssueKind, issue: Issue): string {
    return `${kind === "bug" ? "fix" : "feat"}: ${issue.title}`;
  }

  async #session(
    role: "implementer" | "reviewer" | "architect",
    issueNumber: number,
  ): Promise<string | undefined> {
    return resolveSession(await this.#state.read(), role, issueNumber);
  }

  async #remember(
    role: "implementer" | "reviewer" | "architect",
    issueNumber: number,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId === undefined) {
      return;
    }
    await this.#state.update((state) => ({
      ...rememberSession(state, role, issueNumber, sessionId),
      updatedAt: this.#now().toISOString(),
    }));
  }

  async #block(
    issue: Issue,
    kind: IssueKind,
    branch: string,
    reason: string,
    meta: {
      readonly reviewRounds?: number;
      readonly architecture?: ArchitectureGateStatus;
    } = {},
  ): Promise<ProcessResult> {
    await this.#tracker.block(issue, reason);
    await this.#setIssue(issue, kind, branch, "blocked", {
      lastError: reason,
    });
    return {
      issueNumber: issue.number,
      kind,
      outcome: "blocked",
      branch,
      reviewRounds: meta.reviewRounds ?? 0,
      architecture: meta.architecture ?? "skipped",
      reason,
    };
  }

  async #setIssue(
    issue: Issue,
    kind: IssueKind,
    branch: string,
    status: IssueStatus,
    patch: { readonly prNumber?: number; readonly lastError?: string } = {},
  ): Promise<void> {
    const record: IssueRecord = {
      number: issue.number,
      kind,
      branch,
      status,
      updatedAt: this.#now().toISOString(),
      ...(patch.prNumber === undefined ? {} : { prNumber: patch.prNumber }),
      ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
    };
    await this.#state.update((state: FactoryState) => ({
      ...state,
      issues: {
        ...state.issues,
        [String(issue.number)]: record,
      },
      updatedAt: record.updatedAt,
    }));
  }
}
