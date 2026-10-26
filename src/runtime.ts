import { resolve } from "node:path";

import type { CommandRunner } from "./command.js";
import { issuePolicy, type FactoryConfig } from "./config.js";
import { Factory } from "./factory.js";
import { GitRepo } from "./git.js";
import { GitHubTracker } from "./github.js";
import type { FactoryLogger } from "./ports.js";
import { SandcastleAgentRunner } from "./sandcastle.js";
import { FileStateStore } from "./state.js";
import { WorktreeRegistry } from "./worktrees.js";

export interface FactoryRuntime {
  readonly factory: Factory;
  readonly agents: SandcastleAgentRunner;
  readonly tracker: GitHubTracker;
  close(): Promise<void>;
}

const consoleLogger: FactoryLogger = {
  info(message) {
    console.log(`[softfac] ${message}`);
  },
  warn(message) {
    console.warn(`[softfac] warning: ${message}`);
  },
};

export function createRuntime(
  config: FactoryConfig,
  repoPath: string,
  options: {
    readonly runner?: CommandRunner;
    readonly logger?: FactoryLogger;
  } = {},
): FactoryRuntime {
  if (config.repo.trim() === "") {
    throw new Error(
      "config.repo is empty. Set it to the GitHub owner/repo in .softfac/config.json.",
    );
  }

  const registry = new WorktreeRegistry();
  const git = new GitRepo({
    repoPath,
    baseBranch: config.baseBranch,
    branchPrefix: config.branchPrefix,
    worktreeForBranch: (branch) => registry.get(branch),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const tracker = new GitHubTracker({
    repo: config.repo,
    baseBranch: config.baseBranch,
    labels: {
      ready: config.labels.ready,
      running: config.labels.running,
      blocked: config.labels.blocked,
    },
    policy: issuePolicy(config),
    trustedAuthors: config.review.trustedAuthors,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const agents = new SandcastleAgentRunner({
    repoPath,
    baseBranch: config.baseBranch,
    sandbox: config.sandbox,
    agents: config.agents,
    prompts: config.prompts,
    worktrees: registry,
  });
  const state = new FileStateStore(resolve(repoPath, config.statePath));
  const factory = new Factory({
    config,
    tracker,
    git,
    agents,
    state,
    logger: options.logger ?? consoleLogger,
  });

  return {
    factory,
    agents,
    tracker,
    close: () => agents.close(),
  };
}
