import {
  architectureReviewPath,
  decisionLabel,
  newFollowUps,
  shouldRunArchitectureReview,
  truncateDiff,
  type ArchitectureVerdict,
} from "./architecture.js";
import {
  buildArchitectureContext,
  readableDocumentPaths,
  type ArchitectureDocument,
} from "./architecture-context.js";
import { issuePolicy, type FactoryConfig } from "./config.js";
import {
  classifyIssue,
  type IssueKind,
  type PolicyResult,
} from "./policy.js";
import { buildPullRequestBody } from "./pr.js";
import type {
  AgentRunner,
  ArchitectResult,
  FactoryLogger,
  GitOps,
  ImplementerInput,
  ImplementerResult,
  Issue,
  IssueTracker,
  ReviewInput,
  ReviewResult,
  StateStore,
} from "./ports.js";
import {
  rememberSession,
  resolveSession,
  reviewerArea,
} from "./sessions.js";
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
  readonly sleep?: (ms: number) => Promise<void>;
}

interface GateResult {
  readonly status: ArchitectureGateStatus;
  readonly summary?: string;
}

interface GateAndVerifyResult {
  readonly gate: GateResult;
  /** Set when the gate rejects or verification fails; nothing was pushed. */
  readonly failure?: string;
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
  readonly #sleep: (ms: number) => Promise<void>;
  #recovered = false;

  constructor(deps: FactoryDeps) {
    this.#config = deps.config;
    this.#tracker = deps.tracker;
    this.#git = deps.git;
    this.#agents = deps.agents;
    this.#state = deps.state;
    this.#now = deps.now ?? (() => new Date());
    this.#logger = deps.logger;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async recoverInterrupted(): Promise<number> {
    const state = await this.#state.read();
    const stale = Object.values(state.issues).filter(
      (record) =>
        record.status === "running" ||
        record.status === "reviewing" ||
        record.status === "architecture" ||
        record.status === "feedback",
    );
    if (stale.length === 0) {
      return 0;
    }

    // Only a requeued issue can drop out of listReady while the label index
    // catches up; a feedback record stays in the review pile.
    let requeued = 0;
    for (const record of stale) {
      if (record.status === "feedback") {
        // The issue is still in the human review pile; only the feedback
        // round was interrupted, so re-poll the PR instead of requeueing it.
        this.#logger?.info(
          `issue #${record.number}: will re-poll the PR for feedback after an interrupted run`,
        );
        continue;
      }
      await this.#tracker.requeue(record.number);
      requeued += 1;
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
          status: record.status === "feedback" ? "pull-request" : "pending",
          updatedAt,
        };
      }
      return { ...current, issues, updatedAt };
    });

    return requeued;
  }

  async runOnce(): Promise<ProcessResult[]> {
    let requeued = 0;
    if (!this.#recovered) {
      requeued = await this.recoverInterrupted();
      this.#recovered = true;
    }
    let issues = await this.#tracker.listReady();
    // Requeuing rewrites the label, and the tracker's label index can lag that
    // write: the same cycle may still list nothing and report a no-op.
    for (let attempt = 0; requeued > 0 && issues.length === 0 && attempt < 3; attempt += 1) {
      await this.#sleep(1000 * (attempt + 1));
      issues = await this.#tracker.listReady();
    }
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

    // Human review arrives after an issue leaves the ready pile, so it is
    // polled separately and never re-runs the first implementation.
    results.push(...(await this.#addressFeedback()));
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

  async #addressFeedback(): Promise<ProcessResult[]> {
    const state = await this.#state.read();
    const waiting = Object.values(state.issues)
      .filter(
        (record): record is IssueRecord & { prNumber: number } =>
          record.status === "pull-request" && record.prNumber !== undefined,
      )
      .sort((left, right) => left.number - right.number);

    const results: ProcessResult[] = [];
    for (const record of waiting) {
      try {
        const result = await this.#addressIssueFeedback(record);
        if (result !== undefined) {
          results.push(result);
        }
      } catch (error) {
        // A single unreadable PR must not stop the rest of the cycle.
        this.#logger?.warn(
          `issue #${record.number}: could not poll PR #${record.prNumber} for feedback: ` +
            errorMessage(error),
        );
      } finally {
        // Feedback work gets the same cleanup as the initial path; without it
        // a daemon keeps one worktree and sandbox per reviewed PR until exit.
        try {
          await this.#agents.releaseWorktree(record.branch);
        } catch (error) {
          this.#logger?.warn(
            `issue #${record.number}: could not release the worktree for ` +
              `${record.branch}: ${errorMessage(error)}`,
          );
        }
      }
    }
    return results;
  }

  async #addressIssueFeedback(
    record: IssueRecord & { prNumber: number },
  ): Promise<ProcessResult | undefined> {
    const prNumber = record.prNumber;
    const discussion = await this.#tracker.pullRequestDiscussion(prNumber);
    if (discussion.state !== "OPEN") {
      return undefined;
    }

    const addressed = new Set(record.addressedFeedback ?? []);
    const fresh = discussion.feedback.filter((item) => !addressed.has(item.id));
    if (fresh.length === 0) {
      return undefined;
    }

    const issue = await this.#tracker.getIssue(record.number);
    const policy = issuePolicy(this.#config);
    const kind = classifyIssue(issue.labels, policy);
    const area = reviewerArea(issue.labels, policy);
    const branch = record.branch;
    this.#logger?.info(
      `issue #${issue.number}: addressing ${fresh.length} human review ` +
        `comment(s) on PR #${prNumber}`,
    );
    // The implementer adds commits; it does not own the branch. An amend or
    // rebase here can drop the architect's approved commit, which makes the
    // push non-fast-forward and silently discards a review that already ran.
    const preFeedbackHead = await this.#git.headSha(branch);
    // A round that blocked after the implementer committed (a failed gate, a
    // crash) left those commits on the branch. Starting over would ask for the
    // same comment twice, and the second answer is always "no commits". The
    // recorded base tells a resume apart from a genuinely new comment.
    const resuming =
      record.feedbackBase !== undefined &&
      record.feedbackBase !== preFeedbackHead;
    // A crash mid-round must not requeue the issue as fresh work; recovery
    // turns this back into "pull-request" and the PR is polled again.
    await this.#setIssue(issue, kind, branch, "feedback", {
      prNumber,
      feedbackBase: record.feedbackBase ?? preFeedbackHead,
    });

    const feedback: ReviewResult = {
      verdict: "changes_requested",
      summary: `A human reviewer requested changes on PR #${prNumber}. Address every point below.`,
      findings: fresh.map((item) => `${item.author}: ${item.body}`),
      commits: 0,
    };

    let implementerSession = await this.#session("implementer", issue.number);
    let implementation: ImplementerResult | undefined;
    if (resuming) {
      this.#logger?.info(
        `issue #${issue.number}: resuming the feedback round from ` +
          `${preFeedbackHead.slice(0, 7)}; the commits are already on ${branch}`,
      );
    } else {
      implementation = await this.#agents.implement(
        this.#implementerInput(issue, branch, implementerSession, feedback),
      );
      await this.#remember("implementer", issue.number, implementation.sessionId);
      if (implementation.commits <= 0) {
        return this.#block(
          issue,
          kind,
          branch,
          `Implementer produced no commits while addressing review feedback on PR #${prNumber}.`,
          { prNumber },
        );
      }
    }

    let reviewerSession = await this.#session("reviewer", issue.number, area);
    let review = await this.#agents.review(
      this.#reviewerInput(
        issue,
        branch,
        reviewerSession,
        implementation?.sessionId,
      ),
    );
    await this.#remember("reviewer", issue.number, review.sessionId, area);
    reviewerSession = review.sessionId ?? reviewerSession;

    let totalRounds = 1;
    let extraRounds = 0;
    while (review.verdict !== "approved") {
      if (extraRounds >= this.#config.review.maxRounds) {
        break;
      }
      extraRounds += 1;
      totalRounds += 1;

      implementation = await this.#agents.implement(
        this.#implementerInput(
          issue,
          branch,
          implementation?.sessionId ?? implementerSession,
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
          `Implementer produced no commits while addressing review feedback on PR #${prNumber} (round ${totalRounds}).`,
          { reviewRounds: totalRounds, prNumber },
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
      await this.#remember("reviewer", issue.number, review.sessionId, area);
      reviewerSession = review.sessionId ?? reviewerSession;
    }

    if (review.verdict !== "approved") {
      const findings = review.findings.map((finding) => `- ${finding}`).join("\n");
      return this.#block(
        issue,
        kind,
        branch,
        `Review still requests changes on the human feedback for PR #${prNumber} after ${totalRounds} rounds: ${review.summary}` +
          (findings === "" ? "" : `\n${findings}`),
        { reviewRounds: totalRounds, prNumber },
      );
    }

    if (!(await this.#git.isAncestor(preFeedbackHead, branch))) {
      return this.#block(
        issue,
        kind,
        branch,
        `The implementer rewrote the history of ${branch} while addressing PR #${prNumber}: ` +
          `${preFeedbackHead} is no longer an ancestor. Restore the branch to that commit ` +
          "before the feedback can be merged.",
        { reviewRounds: totalRounds, prNumber },
      );
    }

    // The commits produced for the feedback are still local, so the approval
    // on the remote head no longer describes them. Re-run the gate before the
    // push and let it replace the architecture label.
    const outcome = await this.#gateAndVerify(
      issue,
      kind,
      branch,
      ` after the human feedback on PR #${prNumber}`,
    );
    if (outcome.failure !== undefined) {
      return this.#block(issue, kind, branch, outcome.failure, {
        reviewRounds: totalRounds,
        prNumber,
      });
    }
    const gate = outcome.gate;

    await this.#git.push(branch);
    await this.#tracker.comment(
      issue,
      `Addressed ${fresh.length} human review comment(s) on PR #${prNumber} in ` +
        `${totalRounds} review round(s). The issue stays in the human review pile ` +
        "until the PR is merged.",
    );
    await this.#setIssue(issue, kind, branch, "pull-request", {
      prNumber,
      addressedFeedback: fresh.map((item) => item.id),
      // The round is pushed and verified; the next comment starts a new one.
      feedbackBase: null,
    });

    return {
      issueNumber: issue.number,
      kind,
      outcome: "pull-request",
      branch,
      reviewRounds: totalRounds,
      architecture: gate.status,
      prNumber,
    };
  }

  async #runIssue(
    issue: Issue,
    kind: IssueKind,
    branch: string,
  ): Promise<ProcessResult> {
    this.#logger?.info(`issue #${issue.number} (${kind}) on ${branch}`);
    await this.#tracker.claim(issue);
    await this.#setIssue(issue, kind, branch, "running");
    const area = reviewerArea(issue.labels, issuePolicy(this.#config));

    let implementerSession = await this.#session("implementer", issue.number);
    let implementation = await this.#agents.implement(
      this.#implementerInput(issue, branch, implementerSession),
    );
    await this.#remember("implementer", issue.number, implementation.sessionId);

    if (implementation.commits <= 0) {
      // A resumed issue already carries the work from the interrupted run, so
      // the branch, not this run's commit count, decides whether work exists.
      const existing = await this.#git.countCommits(branch, this.#config.baseBranch);
      if (existing <= 0) {
        return this.#block(
          issue,
          kind,
          branch,
          `Implementer produced no commits on ${branch}.`,
        );
      }
      this.#logger?.info(
        `issue #${issue.number}: no new commits; continuing with ${existing} commit(s) already on ${branch}`,
      );
    }

    await this.#setIssue(issue, kind, branch, "reviewing");
    let reviewerSession = await this.#session("reviewer", issue.number, area);
    let review = await this.#agents.review(
      this.#reviewerInput(issue, branch, reviewerSession, implementation.sessionId),
    );
    await this.#remember("reviewer", issue.number, review.sessionId, area);
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
      await this.#remember("reviewer", issue.number, review.sessionId, area);
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
    const outcome = await this.#gateAndVerify(issue, kind, branch);
    if (outcome.failure !== undefined) {
      return this.#block(issue, kind, branch, outcome.failure, {
        reviewRounds: totalRounds,
        architecture: outcome.gate.status,
      });
    }
    const gate = outcome.gate;
    // The PR is merged against exactly this commit, not against whatever the
    // branch points at by the time the merge runs.
    const verifiedHead = await this.#git.headSha(branch);

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
      // The merge is a hard gate: run the same policy check that CI runs
      // against the live PR. A prompt cannot be trusted to enforce it, and a
      // merge cannot be undone by the policy check afterwards.
      let policy: PolicyResult;
      try {
        policy = await this.#tracker.pullRequestPolicy(pr.number);
      } catch (error) {
        return this.#block(
          issue,
          kind,
          branch,
          `Refusing to auto-merge PR #${pr.number}: the policy check failed: ${errorMessage(error)}`,
          {
            reviewRounds: totalRounds,
            architecture: gate.status,
            prNumber: pr.number,
          },
        );
      }
      if (!policy.ok) {
        const reasons = policy.violations
          .map((violation) => `[${violation.code}] ${violation.message}`)
          .join("\n");
        return this.#block(
          issue,
          kind,
          branch,
          `Refusing to auto-merge PR #${pr.number}; the PR policy is not satisfied:\n${reasons}`,
          {
            reviewRounds: totalRounds,
            architecture: gate.status,
            prNumber: pr.number,
          },
        );
      }

      try {
        await this.#tracker.mergePullRequest(pr.number, verifiedHead);
      } catch (error) {
        return this.#block(
          issue,
          kind,
          branch,
          `Refusing to auto-merge PR #${pr.number} at verified head ` +
            `${verifiedHead}: merge failed: ${errorMessage(error)}`,
          {
            reviewRounds: totalRounds,
            architecture: gate.status,
            prNumber: pr.number,
          },
        );
      }
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

  /**
   * The ordering is the invariant: the architecture gate sees the new commits
   * before verification, and both run before anything is pushed. Keeping it in
   * one place stops the initial and feedback paths from drifting.
   */
  async #gateAndVerify(
    issue: Issue,
    kind: IssueKind,
    branch: string,
    context = "",
  ): Promise<GateAndVerifyResult> {
    const gate = await this.#architectureGate(issue, kind, branch);
    if (gate.status === "changes_requested") {
      return {
        gate,
        failure: `Architecture review requested changes${context}: ${gate.summary ?? "see review"}`,
      };
    }
    const verificationFailure = await this.#verify(branch);
    return verificationFailure === undefined
      ? { gate }
      : { gate, failure: verificationFailure };
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
    const repositoryContext = await this.#repositoryContext(
      branch,
      await this.#git.changedFiles(branch, since),
    );
    const result: ArchitectResult = await this.#agents.architect({
      issue,
      branch,
      fromSha: since,
      toSha,
      commits,
      diff,
      repositoryContext,
      priorDecisions: state.architecture.decisions,
    });

    const filed = await this.#fileFollowUps(
      issue,
      newFollowUps(result.verdict.followUps, state.architecture.decisions),
      { fromSha: since, toSha },
    );

    const path = architectureReviewPath({ date: this.#now(), sha: toSha });
    await this.#git.commitFile(
      branch,
      path,
      this.#architectureReviewMarkdown(
        result.verdict,
        {
          branch,
          fromSha: since,
          toSha,
          commits,
        },
        filed,
      ),
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
        ...(filed.length === 0 ? {} : { filedFollowUps: filed }),
        reviewedAt,
      }),
      updatedAt: reviewedAt,
    }));

    return {
      status: result.verdict.decision,
      summary: result.verdict.summary,
    };
  }

  async #repositoryContext(
    branch: string,
    changedFiles: readonly string[],
  ): Promise<string> {
    try {
      const files = await this.#git.listFiles(branch);
      const documents = await this.#readDocuments(
        branch,
        readableDocumentPaths(files),
      );
      return buildArchitectureContext({ files, changedFiles, documents });
    } catch (error) {
      return `Repository context is unavailable: ${errorMessage(error)}`;
    }
  }

  async #readDocuments(
    branch: string,
    paths: readonly string[],
  ): Promise<ArchitectureDocument[]> {
    const documents: ArchitectureDocument[] = [];
    for (const path of paths) {
      try {
        const content = await this.#git.readFile(branch, path);
        if (content !== undefined && content.trim() !== "") {
          documents.push({ path, content });
        }
      } catch (error) {
        this.#logger?.warn(
          `architecture context: could not read ${path}: ${errorMessage(error)}`,
        );
      }
    }
    return documents;
  }

  async #fileFollowUps(
    issue: Issue,
    followUps: readonly string[],
    range: { readonly fromSha: string | null; readonly toSha: string },
  ): Promise<{ readonly text: string; readonly number: number }[]> {
    const filed: { text: string; number: number }[] = [];
    for (const text of followUps) {
      try {
        const created = await this.#tracker.createIssue({
          title: text,
          body: [
            `Architecture follow-up from the review of #${issue.number}.`,
            "",
            text,
            "",
            `Range: \`${range.fromSha ?? "initial"}..${range.toSha}\``,
          ].join("\n"),
          labels: [this.#config.labels.followUp],
        });
        filed.push({ text, number: created.number });
      } catch (error) {
        this.#logger?.warn(
          `issue #${issue.number}: could not file the architecture follow-up "${text}": ${errorMessage(error)}`,
        );
      }
    }
    return filed;
  }

  #architectureReviewMarkdown(
    verdict: ArchitectureVerdict,
    range: {
      readonly branch: string;
      readonly fromSha: string | null;
      readonly toSha: string;
      readonly commits: number;
    },
    filed: readonly { readonly text: string; readonly number: number }[] = [],
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
        const issueNumber = filed.find(
          (entry) => entry.text === followUp.trim(),
        )?.number;
        lines.push(
          issueNumber === undefined
            ? `- ${followUp}`
            : `- ${followUp} (filed as #${issueNumber})`,
        );
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
    area?: string,
  ): Promise<string | undefined> {
    return resolveSession(await this.#state.read(), role, issueNumber, area);
  }

  async #remember(
    role: "implementer" | "reviewer" | "architect",
    issueNumber: number,
    sessionId: string | undefined,
    area?: string,
  ): Promise<void> {
    if (sessionId === undefined) {
      return;
    }
    await this.#state.update((state) => ({
      ...rememberSession(state, role, issueNumber, sessionId, area),
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
      readonly prNumber?: number;
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
      ...(meta.prNumber === undefined ? {} : { prNumber: meta.prNumber }),
      reason,
    };
  }

  async #setIssue(
    issue: Issue,
    kind: IssueKind,
    branch: string,
    status: IssueStatus,
    patch: {
      readonly prNumber?: number;
      readonly lastError?: string;
      readonly addressedFeedback?: readonly string[];
      readonly feedbackBase?: string | null;
    } = {},
  ): Promise<void> {
    await this.#state.update((state: FactoryState) => {
      const previous = state.issues[String(issue.number)];
      const prNumber = patch.prNumber ?? previous?.prNumber;
      const feedbackBase =
        patch.feedbackBase === null
          ? undefined
          : (patch.feedbackBase ?? previous?.feedbackBase);
      const addressed = new Set(previous?.addressedFeedback ?? []);
      for (const id of patch.addressedFeedback ?? []) {
        addressed.add(id);
      }
      const updatedAt = this.#now().toISOString();
      const record: IssueRecord = {
        number: issue.number,
        kind,
        branch,
        status,
        updatedAt,
        ...(prNumber === undefined ? {} : { prNumber }),
        ...(feedbackBase === undefined ? {} : { feedbackBase }),
        ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
        ...(addressed.size === 0
          ? {}
          : { addressedFeedback: [...addressed] }),
      };
      return {
        ...state,
        issues: {
          ...state.issues,
          [String(issue.number)]: record,
        },
        updatedAt,
      };
    });
  }
}
