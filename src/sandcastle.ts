import { resolve } from "node:path";

import {
  createWorktree,
  pi,
  type AgentProvider,
  type PiOptions,
  type Sandbox,
  type SandboxProvider,
  type Worktree,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";

import type {
  AgentRunner,
  ArchitectInput,
  ArchitectResult,
  ImplementerInput,
  ImplementerResult,
  ReviewInput,
  ReviewResult,
  VerificationResult,
  VerifyInput,
} from "./ports.js";
import { parseReviewOutput } from "./agent-output.js";
import {
  formatArchitectureHistory,
  parseArchitectureVerdict,
} from "./architecture.js";
import type { SandboxKind, ThinkingLevel } from "./config.js";
import { promptArgsForIssue } from "./prompt-args.js";
import type { WorktreeRegistry } from "./worktrees.js";

export interface SandcastleAgentRunnerOptions {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly sandbox: SandboxKind;
  readonly sandboxImage?: string;
  readonly agents: {
    readonly implementerModel: string;
    readonly reviewerModel: string;
    readonly architectModel: string;
    readonly thinking?: ThinkingLevel;
    readonly idleTimeoutSeconds?: number;
  };
  readonly prompts: {
    readonly implementer: string;
    readonly reviewer: string;
    readonly architect: string;
  };
  readonly worktrees: WorktreeRegistry;
}

function sandboxProvider(
  kind: SandboxKind,
  image: string | undefined,
): SandboxProvider {
  if (kind === "no-sandbox") {
    return noSandbox();
  }
  if (kind === "podman") {
    return image === undefined ? podman() : podman({ imageName: image });
  }
  return image === undefined ? docker() : docker({ imageName: image });
}

/**
 * Sandcastle quotes the model and session with POSIX single quotes. The
 * no-sandbox provider runs commands through cmd.exe on Windows, which passes
 * those quotes through literally, so pi receives "'provider/model'" and
 * rejects it. Rebuild the same command without quotes on Windows; model ids
 * and session ids never contain spaces.
 */
export function piAgent(
  model: string,
  options: PiOptions = {},
  platform: NodeJS.Platform = process.platform,
  resumeMode: "session" | "fork" = "session",
): ReturnType<typeof pi> {
  const base = pi(model, options);
  const escape = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    ...base,
    buildPrintCommand: ({ prompt, resumeSession }) => ({
      command:
        `pi -p --mode json --model ${platform === "win32" ? model : escape(model)}` +
        (options.thinking === undefined
          ? ""
          : ` --thinking ${options.thinking}`) +
        (resumeSession === undefined
          ? ""
          : ` --${resumeMode} ${platform === "win32" ? resumeSession : escape(resumeSession)}`),
      stdin: prompt,
    }),
  };
}

function lastSessionId(result: {
  readonly iterations: readonly { readonly sessionId?: string }[];
}): string | undefined {
  return result.iterations.at(-1)?.sessionId;
}

function feedbackText(review: ReviewResult | undefined): string {
  if (review === undefined) {
    return "None. This is the initial implementation.";
  }
  const findings =
    review.findings.length === 0
      ? ""
      : `\n${review.findings.map((finding) => `- ${finding}`).join("\n")}`;
  return `${review.summary}${findings}`;
}

export class SandcastleAgentRunner implements AgentRunner {
  readonly #repoPath: string;
  readonly #baseBranch: string;
  readonly #sandbox: SandboxProvider;
  readonly #implementer: AgentProvider;
  readonly #reviewer: AgentProvider;
  readonly #architect: AgentProvider;
  readonly #prompts: SandcastleAgentRunnerOptions["prompts"];
  readonly #worktrees: WorktreeRegistry;
  readonly #idleTimeoutSeconds: number | undefined;
  readonly #openWorktrees = new Map<string, Worktree>();
  readonly #sandboxes = new Map<string, Sandbox>();

  constructor(options: SandcastleAgentRunnerOptions) {
    this.#repoPath = options.repoPath;
    this.#baseBranch = options.baseBranch;
    this.#sandbox = sandboxProvider(options.sandbox, options.sandboxImage);
    this.#prompts = options.prompts;
    this.#worktrees = options.worktrees;
    this.#idleTimeoutSeconds = options.agents.idleTimeoutSeconds;

    const thinking =
      options.agents.thinking === undefined
        ? {}
        : { thinking: options.agents.thinking };
    this.#implementer = piAgent(options.agents.implementerModel, thinking);
    // The reviewer session is keyed by issue area, so it outlives the worktree
    // it was created in. pi refuses to resume a session from another project
    // directory, so fork it into the worktree of the issue under review.
    this.#reviewer = piAgent(
      options.agents.reviewerModel,
      thinking,
      process.platform,
      "fork",
    );
    this.#architect = piAgent(options.agents.architectModel, thinking);
  }

  worktreePath(branch: string): string | undefined {
    return this.#openWorktrees.get(branch)?.worktreePath;
  }

  /**
   * A long verification command produces no agent events while it runs, so the
   * runner's default idle window can kill a healthy run. Only override it when
   * the project asks for a longer one.
   */
  #timeouts(): { idleTimeoutSeconds?: number } {
    return this.#idleTimeoutSeconds === undefined
      ? {}
      : { idleTimeoutSeconds: this.#idleTimeoutSeconds };
  }

  async #worktree(branch: string): Promise<Worktree> {
    const existing = this.#openWorktrees.get(branch);
    if (existing !== undefined) {
      return existing;
    }

    const worktree = await createWorktree({
      branchStrategy: {
        type: "branch",
        branch,
        baseBranch: this.#baseBranch,
      },
      cwd: this.#repoPath,
    });
    this.#openWorktrees.set(branch, worktree);
    this.#worktrees.set(branch, worktree.worktreePath);
    return worktree;
  }

  #promptFile(role: keyof SandcastleAgentRunnerOptions["prompts"]): string {
    return resolve(this.#repoPath, this.#prompts[role]);
  }

  async #sandboxHandle(branch: string): Promise<Sandbox> {
    const existing = this.#sandboxes.get(branch);
    if (existing !== undefined) {
      return existing;
    }

    const worktree = await this.#worktree(branch);
    const sandbox = await worktree.createSandbox({ sandbox: this.#sandbox });
    this.#sandboxes.set(branch, sandbox);
    return sandbox;
  }

  async releaseWorktree(branch: string): Promise<void> {
    const sandbox = this.#sandboxes.get(branch);
    this.#sandboxes.delete(branch);
    const worktree = this.#openWorktrees.get(branch);
    this.#openWorktrees.delete(branch);
    this.#worktrees.delete(branch);
    // A sandbox created from a worktree owns only its container; the worktree
    // is released separately, even when closing the container fails.
    try {
      if (sandbox !== undefined) {
        await sandbox.close();
      }
    } finally {
      if (worktree !== undefined) {
        await worktree.close();
      }
    }
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    if (input.commands.length === 0) {
      return { passed: true, results: [] };
    }

    const sandbox = await this.#sandboxHandle(input.branch);
    const results = [];
    for (const command of input.commands) {
      const result = await sandbox.exec(command);
      results.push({
        command,
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`,
      });
      if (result.exitCode !== 0) {
        return { passed: false, results };
      }
    }
    return { passed: true, results };
  }

  async implement(input: ImplementerInput): Promise<ImplementerResult> {
    const worktree = await this.#worktree(input.branch);
    const result = await worktree.run({
      agent: this.#implementer,
      sandbox: this.#sandbox,
      promptFile: this.#promptFile("implementer"),
      promptArgs: {
        ...promptArgsForIssue(input.issue, input.branch, this.#baseBranch),
        REVIEW_FEEDBACK: feedbackText(input.feedback),
      },
      maxIterations: 1,
      name: `implement-${input.issue.number}`,
      ...this.#timeouts(),
      ...(input.sessionId === undefined
        ? {}
        : { resumeSession: input.sessionId }),
    });

    const sessionId = lastSessionId(result) ?? input.sessionId;
    return {
      commits: result.commits.length,
      stdout: result.stdout,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const worktree = await this.#worktree(input.branch);
    const result = await worktree.run({
      agent: this.#reviewer,
      sandbox: this.#sandbox,
      promptFile: this.#promptFile("reviewer"),
      promptArgs: {
        ...promptArgsForIssue(input.issue, input.branch, this.#baseBranch),
        IMPLEMENTER_SESSION: input.implementerSessionId ?? "unknown",
      },
      maxIterations: 1,
      name: `review-${input.issue.number}`,
      ...this.#timeouts(),
      ...(input.sessionId === undefined
        ? {}
        : { resumeSession: input.sessionId }),
    });

    if (result.stdout.trim() === "") {
      throw new Error(
        `reviewer produced no output for ${input.branch}; the agent exited without a message (see the review-${input.issue.number} log)`,
      );
    }
    const verdict = parseReviewOutput(result.stdout);
    const sessionId = lastSessionId(result) ?? input.sessionId;
    return {
      ...verdict,
      commits: result.commits.length,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  async architect(input: ArchitectInput): Promise<ArchitectResult> {
    const worktree = await this.#worktree(input.branch);
    const result = await worktree.run({
      agent: this.#architect,
      sandbox: this.#sandbox,
      promptFile: this.#promptFile("architect"),
      promptArgs: {
        ...promptArgsForIssue(input.issue, input.branch, this.#baseBranch),
        FROM_SHA: input.fromSha ?? "initial",
        TO_SHA: input.toSha,
        COMMITS: input.commits,
        DIFF: input.diff,
        REPOSITORY_CONTEXT: input.repositoryContext,
        PRIOR_DECISIONS: formatArchitectureHistory(input.priorDecisions),
      },
      maxIterations: 1,
      name: `architect-${input.issue.number}`,
      ...this.#timeouts(),
    });

    return {
      verdict: parseArchitectureVerdict(result.stdout),
      stdout: result.stdout,
    };
  }

  async close(): Promise<void> {
    for (const [branch, sandbox] of [...this.#sandboxes]) {
      try {
        await sandbox.close();
      } finally {
        this.#sandboxes.delete(branch);
      }
    }
    for (const [branch, worktree] of [...this.#openWorktrees]) {
      try {
        await worktree.close();
      } finally {
        this.#openWorktrees.delete(branch);
        this.#worktrees.delete(branch);
      }
    }
  }
}
