import type { PolicyOptions } from "./policy.js";

export type SandboxKind = "docker" | "podman" | "no-sandbox";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface FactoryConfig {
  readonly repo: string;
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly labels: {
    readonly ready: string;
    readonly running: string;
    readonly blocked: string;
    readonly needsHuman: string;
    readonly followUp: string;
    readonly bug: string;
    readonly substantial: readonly string[];
  };
  readonly architecture: {
    readonly everyCommits: number;
    readonly requireForSubstantial: boolean;
    readonly maxDiffChars: number;
  };
  readonly review: {
    readonly maxRounds: number;
    readonly trustedAuthors: readonly string[];
  };
  readonly tdd: {
    readonly testPatterns: readonly string[];
  };
  readonly verification: {
    readonly commands: readonly string[];
  };
  readonly bugs: {
    readonly autoClose: boolean;
    readonly autoMerge: boolean;
  };
  readonly maxIssuesPerRun: number;
  readonly pollIntervalMs: number;
  readonly sandbox: SandboxKind;
  readonly agents: {
    readonly implementerModel: string;
    readonly reviewerModel: string;
    readonly architectModel: string;
    readonly thinking?: ThinkingLevel;
    /** Seconds without agent output before the run fails; the runner default applies when omitted. */
    readonly idleTimeoutSeconds?: number;
  };
  readonly prompts: {
    readonly implementer: string;
    readonly reviewer: string;
    readonly architect: string;
  };
  readonly statePath: string;
  readonly logDir: string;
}

const DEFAULT_CONFIG: FactoryConfig = {
  repo: "",
  baseBranch: "main",
  branchPrefix: "softfac/",
  labels: {
    ready: "softfac:ready",
    running: "softfac:running",
    blocked: "softfac:blocked",
    needsHuman: "softfac:needs-human",
    followUp: "softfac:follow-up",
    bug: "bug",
    substantial: ["feature", "architecture", "epic"],
  },
  architecture: {
    everyCommits: 10,
    requireForSubstantial: true,
    maxDiffChars: 60_000,
  },
  review: {
    maxRounds: 2,
    trustedAuthors: [],
  },
  tdd: {
    testPatterns: [
      "tests/**",
      "test/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
    ],
  },
  verification: {
    commands: [],
  },
  bugs: {
    autoClose: true,
    autoMerge: false,
  },
  maxIssuesPerRun: 1,
  pollIntervalMs: 60_000,
  sandbox: "docker",
  agents: {
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-sonnet-4-6",
    architectModel: "claude-opus-4-8",
  },
  prompts: {
    implementer: ".softfac/prompts/implementer.md",
    reviewer: ".softfac/prompts/reviewer.md",
    architect: ".softfac/prompts/architect.md",
  },
  statePath: ".softfac/state.json",
  logDir: ".softfac/logs",
};

export function defaultConfig(): FactoryConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function issuePolicy(config: FactoryConfig): PolicyOptions {
  return {
    bugLabels: [config.labels.bug],
    substantialLabels: config.labels.substantial,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(
  source: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = source[field];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`config.${field} must be an object`);
  }
  return value;
}

function stringField(
  source: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const value = source[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`config.${field} must be a non-empty string`);
  }
  return value;
}

function booleanField(
  source: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = source[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`config.${field} must be a boolean`);
  }
  return value;
}

function integerField(
  source: Record<string, unknown>,
  field: string,
  fallback: number,
  min: number,
): number {
  const value = source[field];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`config.${field} must be an integer >= ${min}`);
  }
  return value as number;
}

function stringArrayField(
  source: Record<string, unknown>,
  field: string,
  fallback: readonly string[],
  path = field,
): readonly string[] {
  const value = source[field];
  if (value === undefined) {
    return fallback;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`config.${path} must be an array of non-empty strings`);
  }
  return value;
}

function sandboxField(
  source: Record<string, unknown>,
  fallback: SandboxKind,
): SandboxKind {
  const value = source["sandbox"];
  if (value === undefined) {
    return fallback;
  }
  if (value !== "docker" && value !== "podman" && value !== "no-sandbox") {
    throw new Error(
      'config.sandbox must be "docker", "podman", or "no-sandbox"',
    );
  }
  return value;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function parseConfig(value: unknown): FactoryConfig {
  if (!isRecord(value)) {
    throw new Error("config must be an object");
  }

  const defaults = defaultConfig();
  const labels = recordField(value, "labels");
  const architecture = recordField(value, "architecture");
  const review = recordField(value, "review");
  const tdd = recordField(value, "tdd");
  const verification = recordField(value, "verification");
  const bugs = recordField(value, "bugs");
  const agents = recordField(value, "agents");
  const prompts = recordField(value, "prompts");

  const testPatterns = stringArrayField(
    tdd,
    "testPatterns",
    defaults.tdd.testPatterns,
  );
  if (testPatterns.length === 0) {
    throw new Error("config.tdd.testPatterns must not be empty");
  }

  const thinking = agents["thinking"];
  if (
    thinking !== undefined &&
    (typeof thinking !== "string" ||
      !THINKING_LEVELS.includes(thinking as ThinkingLevel))
  ) {
    throw new Error(
      `config.agents.thinking must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }

  const idleTimeoutSeconds = agents["idleTimeoutSeconds"];
  if (
    idleTimeoutSeconds !== undefined &&
    (!Number.isInteger(idleTimeoutSeconds) ||
      (idleTimeoutSeconds as number) < 1)
  ) {
    throw new Error("config.agents.idleTimeoutSeconds must be an integer >= 1");
  }

  const parsed: FactoryConfig = {
    repo: stringField(value, "repo", defaults.repo),
    baseBranch: stringField(value, "baseBranch", defaults.baseBranch),
    branchPrefix: stringField(value, "branchPrefix", defaults.branchPrefix),
    labels: {
      ready: stringField(labels, "ready", defaults.labels.ready),
      running: stringField(labels, "running", defaults.labels.running),
      blocked: stringField(labels, "blocked", defaults.labels.blocked),
      needsHuman: stringField(labels, "needsHuman", defaults.labels.needsHuman),
      followUp: stringField(labels, "followUp", defaults.labels.followUp),
      bug: stringField(labels, "bug", defaults.labels.bug),
      substantial: stringArrayField(
        labels,
        "substantial",
        defaults.labels.substantial,
      ),
    },
    architecture: {
      everyCommits: integerField(
        architecture,
        "everyCommits",
        defaults.architecture.everyCommits,
        0,
      ),
      requireForSubstantial: booleanField(
        architecture,
        "requireForSubstantial",
        defaults.architecture.requireForSubstantial,
      ),
      maxDiffChars: integerField(
        architecture,
        "maxDiffChars",
        defaults.architecture.maxDiffChars,
        1,
      ),
    },
    review: {
      maxRounds: integerField(review, "maxRounds", defaults.review.maxRounds, 0),
      trustedAuthors: stringArrayField(
        review,
        "trustedAuthors",
        defaults.review.trustedAuthors,
        "review.trustedAuthors",
      ),
    },
    tdd: { testPatterns },
    verification: {
      commands: stringArrayField(
        verification,
        "commands",
        defaults.verification.commands,
        "verification.commands",
      ),
    },
    bugs: {
      autoClose: booleanField(bugs, "autoClose", defaults.bugs.autoClose),
      autoMerge: booleanField(bugs, "autoMerge", defaults.bugs.autoMerge),
    },
    maxIssuesPerRun: integerField(
      value,
      "maxIssuesPerRun",
      defaults.maxIssuesPerRun,
      1,
    ),
    pollIntervalMs: integerField(
      value,
      "pollIntervalMs",
      defaults.pollIntervalMs,
      0,
    ),
    sandbox: sandboxField(value, defaults.sandbox),
    agents: {
      implementerModel: stringField(
        agents,
        "implementerModel",
        defaults.agents.implementerModel,
      ),
      reviewerModel: stringField(
        agents,
        "reviewerModel",
        defaults.agents.reviewerModel,
      ),
      architectModel: stringField(
        agents,
        "architectModel",
        defaults.agents.architectModel,
      ),
      ...(thinking === undefined ? {} : { thinking: thinking as ThinkingLevel }),
      ...(idleTimeoutSeconds === undefined
        ? {}
        : { idleTimeoutSeconds: idleTimeoutSeconds as number }),
    },
    prompts: {
      implementer: stringField(
        prompts,
        "implementer",
        defaults.prompts.implementer,
      ),
      reviewer: stringField(prompts, "reviewer", defaults.prompts.reviewer),
      architect: stringField(prompts, "architect", defaults.prompts.architect),
    },
    statePath: stringField(value, "statePath", defaults.statePath),
    logDir: stringField(value, "logDir", defaults.logDir),
  };

  if (parsed.bugs.autoMerge && parsed.verification.commands.length === 0) {
    throw new Error(
      "config.bugs.autoMerge requires at least one command in config.verification.commands; an unverified merge is not allowed.",
    );
  }

  return parsed;
}
