import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPullRequestBody } from "../src/pr.js";
import type { Issue } from "../src/ports.js";

const issue: Issue = {
  number: 42,
  title: "Fix the thing",
  body: "",
  url: "https://example.test/issues/42",
  labels: ["bug"],
};

test("bug PRs include a closing reference and regression-test proof", () => {
  const body = buildPullRequestBody({
    kind: "bug",
    issue,
    branch: "softfac/42",
    reviewSummary: "The regression is covered.",
  });

  assert.match(body, /Fixes #42/);
  assert.match(body, /-\s*\[x\][^\n]*regression test/i);
  assert.match(body, /The regression is covered\./);
  assert.doesNotMatch(body, /Part of #42/);
});

test("does not claim verification that did not run", () => {
  const body = buildPullRequestBody({
    kind: "normal",
    issue,
    branch: "softfac/42",
    reviewSummary: "Docs only.",
  });

  assert.doesNotMatch(body, /-\s*\[x\][^\n]*test suite/i);
  assert.match(body, /-\s*\[ \][^\n]*no verification commands/i);
});

test("records the verification commands that passed", () => {
  const body = buildPullRequestBody({
    kind: "normal",
    issue,
    branch: "softfac/42",
    reviewSummary: "Docs only.",
    verification: ["npm test", "npm run typecheck"],
  });

  assert.match(
    body,
    /-\s*\[x\] Verified by SoftFac: `npm test`, `npm run typecheck`\./,
  );
  assert.doesNotMatch(body, /no verification commands/i);
});

test("substantial PRs use a partial reference and never auto-close", () => {
  const body = buildPullRequestBody({
    kind: "substantial",
    issue,
    branch: "softfac/42",
    reviewSummary: "Introduces the billing boundary.",
    architectureSummary: "The boundary is coherent.",
  });

  assert.match(body, /Part of #42/);
  assert.doesNotMatch(body, /\b(?:fix|close|resolve)(?:e[sd])?\s+#42\b/i);
  assert.match(body, /The boundary is coherent\./);
});

test("normal PRs use a partial reference", () => {
  const body = buildPullRequestBody({
    kind: "normal",
    issue,
    branch: "softfac/42",
    reviewSummary: "Docs only.",
  });

  assert.match(body, /Part of #42/);
  assert.doesNotMatch(body, /Fixes #42/);
});
