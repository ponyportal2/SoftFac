import { formatArchitectureHistory } from "./architecture.js";
import type { FactoryConfig } from "./config.js";
import type { FactoryState, IssueRecord, IssueStatus } from "./state.js";

const STATUS_RANK: Record<IssueStatus, number> = {
  running: 0,
  reviewing: 1,
  architecture: 2,
  feedback: 3,
  pending: 4,
  "pull-request": 5,
  blocked: 6,
  failed: 7,
  done: 8,
};

const HISTORY_PREVIEW = 3;

function issueLine(record: IssueRecord): string {
  const target =
    record.prNumber === undefined
      ? record.branch
      : `PR #${record.prNumber} (${record.branch})`;
  const columns = [
    `#${record.number}`.padEnd(6),
    record.kind.padEnd(12),
    record.status.padEnd(14),
    target,
  ];
  if (record.lastError !== undefined) {
    columns.push(`- ${record.lastError.replace(/\s+/g, " ").trim()}`);
  }
  return columns.join(" ");
}

export function formatStatus(
  state: FactoryState,
  config: FactoryConfig,
): string {
  const lines: string[] = [
    "SoftFac status",
    `repo: ${config.repo} -> ${config.baseBranch}`,
    `updated: ${state.updatedAt}`,
    "",
  ];

  const issues = Object.values(state.issues).sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      left.number - right.number,
  );
  lines.push(`Issues (${issues.length})`);
  if (issues.length === 0) {
    lines.push("  none");
  } else {
    for (const issue of issues) {
      lines.push(`  ${issueLine(issue)}`);
    }
  }

  const sessions = Object.entries(state.sessions).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  lines.push("", `Sessions (${sessions.length})`);
  if (sessions.length === 0) {
    lines.push("  none");
  } else {
    for (const [key, sessionId] of sessions) {
      lines.push(`  ${key} = ${sessionId}`);
    }
  }

  lines.push("", "Architecture");
  lines.push(`  anchor: ${state.architecture.lastReviewedBaseSha ?? "none"}`);
  lines.push(`  decisions: ${state.architecture.decisions.length}`);
  const history = formatArchitectureHistory(
    state.architecture.decisions.slice(0, HISTORY_PREVIEW),
  );
  for (const line of history.split("\n")) {
    lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}
