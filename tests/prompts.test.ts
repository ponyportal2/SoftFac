import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPrompt } from "../src/prompts.js";

test("replaces placeholders with values", () => {
  assert.equal(
    renderPrompt("Issue #{{ISSUE_NUMBER}}: {{TITLE}}", {
      ISSUE_NUMBER: 42,
      TITLE: "Fix it",
    }),
    "Issue #42: Fix it",
  );
});

test("replaces every occurrence", () => {
  assert.equal(
    renderPrompt("{{A}} + {{A}}", { A: "x" }),
    "x + x",
  );
});

test("allows whitespace inside a placeholder", () => {
  assert.equal(renderPrompt("{{ A }}", { A: "x" }), "x");
});

test("does not recursively expand values", () => {
  assert.equal(
    renderPrompt("{{A}}", { A: "{{B}}", B: "nope" }),
    "{{B}}",
  );
});

test("throws when a placeholder has no value", () => {
  assert.throws(
    () => renderPrompt("{{MISSING}}", {}),
    /missing prompt argument: MISSING/i,
  );
});

test("leaves templates without placeholders unchanged", () => {
  assert.equal(renderPrompt("plain prompt", {}), "plain prompt");
});
