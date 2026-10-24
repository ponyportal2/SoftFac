import type { PolicyOptions } from "./policy.js";
import type { FactoryState } from "./state.js";

export type AgentRole = "implementer" | "reviewer" | "architect";

export function reviewerArea(
  labels: readonly string[],
  options: PolicyOptions,
): string {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  if (
    options.bugLabels.some((label) =>
      normalized.has(label.trim().toLowerCase()),
    )
  ) {
    return "bug";
  }
  for (const label of options.substantialLabels) {
    const key = label.trim().toLowerCase();
    if (normalized.has(key)) {
      return key;
    }
  }
  return "general";
}

export function sessionKey(
  role: AgentRole,
  issueNumber: number,
  area = "general",
): string | null {
  switch (role) {
    case "implementer":
      return `implementer:${issueNumber}`;
    case "reviewer":
      return `reviewer:${area}`;
    case "architect":
      return null;
  }
}

export function resolveSession(
  state: FactoryState,
  role: AgentRole,
  issueNumber: number,
  area?: string,
): string | undefined {
  const key = sessionKey(role, issueNumber, area);
  return key === null ? undefined : state.sessions[key];
}

export function rememberSession(
  state: FactoryState,
  role: AgentRole,
  issueNumber: number,
  sessionId: string,
  area?: string,
): FactoryState {
  const key = sessionKey(role, issueNumber, area);
  if (key === null) {
    return state;
  }
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [key]: sessionId,
    },
  };
}
