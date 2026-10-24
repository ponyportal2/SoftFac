import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  type FactoryState,
} from "../src/state.js";
import {
  rememberSession,
  resolveSession,
  reviewerArea,
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

test("reviewer sessions are continuous within an area", () => {
  assert.equal(sessionKey("reviewer", 42, "bug"), "reviewer:bug");
  assert.equal(sessionKey("reviewer", 43, "bug"), "reviewer:bug");
  assert.equal(sessionKey("reviewer", 44, "feature"), "reviewer:feature");
});

test("reviewer areas follow the issue classification", () => {
  const policy = {
    bugLabels: ["bug"],
    substantialLabels: ["feature", "architecture"],
  };

  assert.equal(reviewerArea(["bug"], policy), "bug");
  assert.equal(reviewerArea(["Feature", "p1"], policy), "feature");
  assert.equal(reviewerArea(["architecture"], policy), "architecture");
  assert.equal(reviewerArea(["documentation"], policy), "general");
});

test("architect sessions are always fresh", () => {
  assert.equal(sessionKey("architect", 42), null);
});

test("resolves only the session belonging to the role", () => {
  const state = stateWith({
    "implementer:42": "impl-42",
    "reviewer:general": "review-shared",
    "implementer:43": "impl-43",
  });

  assert.equal(resolveSession(state, "implementer", 42), "impl-42");
  assert.equal(
    resolveSession(state, "reviewer", 42, "general"),
    "review-shared",
  );
  assert.equal(resolveSession(state, "architect", 42), undefined);
});

test("remembers a session under the role key", () => {
  const state = stateWith({});
  const updated = rememberSession(state, "implementer", 42, "impl-42");

  assert.equal(updated.sessions["implementer:42"], "impl-42");
  assert.equal(state.sessions["implementer:42"], undefined);
});

test("remembers reviewer sessions under their area key", () => {
  const state = stateWith({});
  const updated = rememberSession(state, "reviewer", 42, "rev-bug", "bug");

  assert.equal(updated.sessions["reviewer:bug"], "rev-bug");
  assert.equal(state.sessions["reviewer:bug"], undefined);
});

test("remembering an architect session is a no-op", () => {
  const state = stateWith({});
  const updated = rememberSession(state, "architect", 42, "arch-1");

  assert.deepEqual(updated.sessions, {});
});
