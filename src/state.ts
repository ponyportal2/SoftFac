import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ArchitectureDecisionRecord,
  FiledFollowUp,
} from "./architecture.js";
import type { IssueKind } from "./policy.js";

export type IssueStatus =
  | "pending"
  | "running"
  | "reviewing"
  | "architecture"
  | "feedback"
  | "pull-request"
  | "done"
  | "blocked"
  | "failed";

export interface IssueRecord {
  readonly number: number;
  readonly status: IssueStatus;
  readonly kind: IssueKind;
  readonly branch: string;
  readonly prNumber?: number;
  readonly lastError?: string;
  /** Feedback ids already addressed, so a comment is never implemented twice. */
  readonly addressedFeedback?: readonly string[];
  readonly updatedAt: string;
}

export interface ArchitectureState {
  readonly lastReviewedBaseSha: string | null;
  readonly decisions: readonly ArchitectureDecisionRecord[];
}

export interface FactoryState {
  readonly version: 2;
  readonly architecture: ArchitectureState;
  readonly sessions: Record<string, string>;
  readonly issues: Record<string, IssueRecord>;
  readonly updatedAt: string;
}

export const ARCHITECTURE_HISTORY_LIMIT = 10;

export function createInitialState(now: Date = new Date()): FactoryState {
  return {
    version: 2,
    architecture: {
      lastReviewedBaseSha: null,
      decisions: [],
    },
    sessions: {},
    issues: {},
    updatedAt: now.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`invalid softfac state: ${field} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`invalid softfac state: ${field}.${key} must be a string`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`invalid softfac state: ${field} must be a string`);
  }
  return value;
}

function parseDecision(
  value: unknown,
  index: number,
): ArchitectureDecisionRecord {
  const field = `architecture.decisions[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`invalid softfac state: ${field} must be an object`);
  }

  const decision = value["decision"];
  if (decision !== "approved" && decision !== "changes_requested") {
    throw new Error(
      `invalid softfac state: ${field}.decision must be "approved" or "changes_requested"`,
    );
  }

  const followUps = value["followUps"];
  if (
    !Array.isArray(followUps) ||
    followUps.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      `invalid softfac state: ${field}.followUps must be an array of strings`,
    );
  }

  const fromSha = value["fromSha"];
  if (fromSha !== null && typeof fromSha !== "string") {
    throw new Error(
      `invalid softfac state: ${field}.fromSha must be null or a string`,
    );
  }

  const filedFollowUps = parseFiledFollowUps(value["filedFollowUps"], field);

  return {
    branch: requireString(value["branch"], `${field}.branch`),
    fromSha,
    toSha: requireString(value["toSha"], `${field}.toSha`),
    anchorSha: requireString(value["anchorSha"], `${field}.anchorSha`),
    decision,
    summary: requireString(value["summary"], `${field}.summary`),
    followUps,
    ...(filedFollowUps === undefined ? {} : { filedFollowUps }),
    reviewedAt: requireString(value["reviewedAt"], `${field}.reviewedAt`),
  };
}

function parseFiledFollowUps(
  value: unknown,
  field: string,
): FiledFollowUp[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `invalid softfac state: ${field}.filedFollowUps must be an array`,
    );
  }
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item["text"] !== "string" ||
      typeof item["number"] !== "number" ||
      !Number.isInteger(item["number"])
    ) {
      throw new Error(
        `invalid softfac state: ${field}.filedFollowUps[${index}] must be {text, number}`,
      );
    }
    return { text: item["text"], number: item["number"] };
  });
}

function parseArchitecture(value: unknown): ArchitectureState {
  if (!isRecord(value)) {
    throw new Error("invalid softfac state: architecture must be an object");
  }

  const lastReviewedBaseSha = value["lastReviewedBaseSha"];
  if (lastReviewedBaseSha !== null && typeof lastReviewedBaseSha !== "string") {
    throw new Error(
      "invalid softfac state: architecture.lastReviewedBaseSha must be null or a string",
    );
  }

  const rawDecisions = value["decisions"];
  if (!Array.isArray(rawDecisions)) {
    throw new Error(
      "invalid softfac state: architecture.decisions must be an array",
    );
  }

  return {
    lastReviewedBaseSha,
    decisions: rawDecisions.map(parseDecision),
  };
}

function parseState(raw: string): FactoryState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("invalid softfac state: not valid JSON", { cause: error });
  }

  if (!isRecord(value)) {
    throw new Error("invalid softfac state: expected an object");
  }
  if (value["version"] !== 1 && value["version"] !== 2) {
    throw new Error("invalid softfac state: unsupported version");
  }

  const sessions = value["sessions"];
  assertStringRecord(sessions, "sessions");
  if (!isRecord(value["issues"])) {
    throw new Error("invalid softfac state: issues must be an object");
  }
  const updatedAt = value["updatedAt"];
  if (typeof updatedAt !== "string") {
    throw new Error("invalid softfac state: updatedAt must be a string");
  }

  if (value["version"] === 1) {
    const legacySha = value["lastArchitectureReviewSha"];
    if (legacySha !== null && typeof legacySha !== "string") {
      throw new Error(
        "invalid softfac state: lastArchitectureReviewSha must be null or a string",
      );
    }
    // Version 1 anchored reviews to a branch head, which a squash merge
    // destroys. Start the mainline cadence fresh instead of reusing it.
    return {
      version: 2,
      architecture: { lastReviewedBaseSha: null, decisions: [] },
      sessions,
      issues: value["issues"] as Record<string, IssueRecord>,
      updatedAt,
    };
  }

  return {
    version: 2,
    architecture: parseArchitecture(value["architecture"]),
    sessions,
    issues: value["issues"] as Record<string, IssueRecord>,
    updatedAt,
  };
}

export function rememberArchitectureDecision(
  state: FactoryState,
  record: ArchitectureDecisionRecord,
  limit: number = ARCHITECTURE_HISTORY_LIMIT,
): FactoryState {
  return {
    ...state,
    architecture: {
      lastReviewedBaseSha: record.anchorSha,
      decisions: [record, ...state.architecture.decisions].slice(
        0,
        Math.max(limit, 0),
      ),
    },
  };
}

export class FileStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<FactoryState> {
    try {
      return parseState(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (
        isRecord(error) &&
        (error["code"] === "ENOENT" || error["code"] === "ENOTDIR")
      ) {
        return createInitialState();
      }
      throw error;
    }
  }

  async write(state: FactoryState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tempPath = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.#path);
  }

  async update(
    mutator: (state: FactoryState) => FactoryState,
  ): Promise<FactoryState> {
    const updated = mutator(await this.read());
    await this.write(updated);
    return updated;
  }
}
