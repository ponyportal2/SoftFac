import type { CommandRunner } from "./command.js";
import type { FactoryConfig } from "./config.js";

export interface LabelDefinition {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

function factoryLabels(config: FactoryConfig): LabelDefinition[] {
  return [
    {
      name: config.labels.ready,
      color: "0E8A16",
      description: "Ready for SoftFac to implement",
    },
    {
      name: config.labels.running,
      color: "FBCA04",
      description: "SoftFac is working on this issue",
    },
    {
      name: config.labels.blocked,
      color: "B60205",
      description: "SoftFac is blocked and needs attention",
    },
    {
      name: config.labels.needsHuman,
      color: "5319E7",
      description: "A pull request is ready for human review",
    },
  ];
}

const ARCHITECTURE_LABELS: readonly LabelDefinition[] = [
  {
    name: "arch:approved",
    color: "0E8A16",
    description: "Architecture review approved",
  },
  {
    name: "arch:changes-requested",
    color: "B60205",
    description: "Architecture review requested changes",
  },
];

export function labelsForConfig(config: FactoryConfig): LabelDefinition[] {
  const configured: LabelDefinition[] = [
    ...factoryLabels(config),
    {
      name: config.labels.bug,
      color: "D73A4A",
      description: "A bug fix",
    },
    ...config.labels.substantial.map((name) => ({
      name,
      color: "1D76DB",
      description: "A substantial change requiring architecture review",
    })),
    ...ARCHITECTURE_LABELS,
  ];

  const seen = new Set<string>();
  return configured.filter((label) => {
    const key = label.name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export interface LabelSyncFailure {
  readonly name: string;
  readonly message: string;
}

export interface LabelSyncResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
  readonly failed: readonly LabelSyncFailure[];
}

export interface SyncLabelsOptions {
  readonly repo: string;
  readonly labels: readonly LabelDefinition[];
  readonly runner: CommandRunner;
  readonly cwd?: string;
}

export async function syncLabels(
  options: SyncLabelsOptions,
): Promise<LabelSyncResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const failed: LabelSyncFailure[] = [];

  for (const label of options.labels) {
    try {
      await options.runner.run(
        "gh",
        [
          "label",
          "create",
          label.name,
          "--repo",
          options.repo,
          "--color",
          label.color,
          "--description",
          label.description,
        ],
        options.cwd === undefined ? {} : { cwd: options.cwd },
      );
      created.push(label.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        existing.push(label.name);
      } else {
        failed.push({ name: label.name, message });
      }
    }
  }

  return { created, existing, failed };
}
