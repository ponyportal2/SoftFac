import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  type FactoryState,
} from "../src/state.js";
import {
  rememberSession,
  resolveSession,
  sessionKey,
} from "../src/sessions.js";

function stateWith(sessions: Record<string, string>): FactoryState {
  return {
    ...createInitialState(new Date("2026-10-24T00:00:00Z")),
    sessions,
  };
}

test("implementer sessions are scoped to an issue", () => {
  assert.equal(sessionKey("implementer", 42), "implementer:42");
  assert.equal(sessionKey("implementer", 43), "implementer:43");
});

test("reviewer sessions are continuous across issues", () => {
  assert.equal(sessionKey("reviewer", 42), "reviewer");
  assert.equal(sessionKey("reviewer", 43), "reviewer");
});

test("architect sessions are always fresh", () => {
  assert.equal(sessionKey("architect", 42), null);
});

test("resolves only the session belonging to the role", () => {
  const state = stateWith({
    "implementer:42": "impl-42",
    reviewer: "review-shared",
    "implementer:43": "impl-43",
  });

  assert.equal(resolveSession(state, "implementer", 42), "impl-42");
  assert.equal(resolveSession(state, "reviewer", 42), "review-shared");
  assert.equal(resolveSession(state, "architect", 42), undefined);
});

test("remembers a session under the role key", () => {
  const state = stateWith({});
  const updated = rememberSession(state, "implementer", 42, "impl-42");

  assert.equal(updated.sessions["implementer:42"], "impl-42");
  assert.equal(state.sessions["implementer:42"], undefined);
});

test("remembering an architect session is a no-op", () => {
  const state = stateWith({});
  const updated = rememberSession(state, "architect", 42, "arch-1");

  assert.deepEqual(updated.sessions, {});
});
