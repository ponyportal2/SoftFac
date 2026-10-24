import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyIssue,
  closingReference,
  validatePullRequest,
  type PullRequestPolicyInput,
} from "../src/policy.js";

const policy = {
  bugLabels: ["bug"],
  substantialLabels: ["feature", "architecture", "epic"],
};

test("classifies a bug from its labels", () => {
  assert.equal(classifyIssue(["bug", "p1"], policy), "bug");
});

test("classifies a substantial change from its labels", () => {
  assert.equal(classifyIssue(["feature"], policy), "substantial");
});

test("classifies an unlabelled change as normal", () => {
  assert.equal(classifyIssue(["docs"], policy), "normal");
});

test("bug labels win over substantial labels", () => {
  assert.equal(classifyIssue(["bug", "feature"], policy), "bug");
});

test("bugs get a closing reference", () => {
  assert.equal(closingReference("bug", 42), "Fixes #42");
});

test("substantial and normal changes only get a partial reference", () => {
  assert.equal(closingReference("substantial", 42), "Part of #42");
  assert.equal(closingReference("normal", 7), "Part of #7");
});

function baseInput(overrides: Partial<PullRequestPolicyInput> = {}): PullRequestPolicyInput {
  return {
    body: "",
    labels: [],
    issue: { number: 42, labels: ["bug"] },
    approvals: { human: 0, architecture: false },
    policy,
    ...overrides,
  };
}

test("accepts a bug PR that closes the issue and proves a regression test", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Fixes #42\n\n- [x] Regression test added and failing before the fix.",
      approvals: { human: 0, architecture: false },
    }),
  );

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("rejects a bug PR without a closing reference", () => {
  const result = validatePullRequest(
    baseInput({
      body: "- [x] Regression test added.",
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["bug-missing-closing-reference"],
  );
});

test("rejects a bug PR without a regression-test declaration", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Fixes #42",
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["bug-missing-regression-test"],
  );
});

test("rejects a substantial PR that uses a closing reference", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Fixes #42",
      issue: { number: 42, labels: ["feature"] },
      approvals: { human: 1, architecture: true },
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["substantial-must-not-auto-close"],
  );
});

test("rejects a substantial PR without architecture approval", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Part of #42",
      issue: { number: 42, labels: ["architecture"] },
      approvals: { human: 1, architecture: false },
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["substantial-missing-architecture-approval"],
  );
});

test("rejects a substantial PR without human approval", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Part of #42",
      issue: { number: 42, labels: ["feature"] },
      approvals: { human: 0, architecture: true },
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["substantial-missing-human-approval"],
  );
});

test("accepts a substantial PR with partial reference and both approvals", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Part of #42",
      issue: { number: 42, labels: ["feature"] },
      approvals: { human: 1, architecture: true },
    }),
  );

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("normal PRs require human approval but not architecture approval", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Part of #42",
      issue: { number: 42, labels: ["docs"] },
      approvals: { human: 1, architecture: false },
    }),
  );

  assert.deepEqual(result, { ok: true, violations: [] });
});

test("normal PRs may not auto-close their issue", () => {
  const result = validatePullRequest(
    baseInput({
      body: "Closes #42",
      issue: { number: 42, labels: ["docs"] },
      approvals: { human: 1, architecture: false },
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["normal-must-not-auto-close"],
  );
});
