import type { FactoryState } from "./state.js";

export type AgentRole = "implementer" | "reviewer" | "architect";

export function sessionKey(
  role: AgentRole,
  issueNumber: number,
): string | null {
  switch (role) {
    case "implementer":
      return `implementer:${issueNumber}`;
    case "reviewer":
      return "reviewer";
    case "architect":
      return null;
  }
}

export function resolveSession(
  state: FactoryState,
  role: AgentRole,
  issueNumber: number,
): string | undefined {
  const key = sessionKey(role, issueNumber);
  return key === null ? undefined : state.sessions[key];
}

export function rememberSession(
  state: FactoryState,
  role: AgentRole,
  issueNumber: number,
  sessionId: string,
): FactoryState {
  const key = sessionKey(role, issueNumber);
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
