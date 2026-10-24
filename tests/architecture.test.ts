import assert from "node:assert/strict";
import { test } from "node:test";

import {
  architectureReviewPath,
  decisionLabel,
  type ArchitectureDecisionRecord,
  formatArchitectureHistory,
  newFollowUps,
  parseArchitectureVerdict,
  shouldRunArchitectureReview,
  truncateDiff,
} from "../src/architecture.js";

test("runs an architecture review when the commit threshold is reached", () => {
  assert.equal(
    shouldRunArchitectureReview({ commitsSinceReview: 9, interval: 10 }),
    false,
  );
  assert.equal(
    shouldRunArchitectureReview({ commitsSinceReview: 10, interval: 10 }),
    true,
  );
  assert.equal(
    shouldRunArchitectureReview({ commitsSinceReview: 31, interval: 10 }),
    true,
  );
});

test("allows the architecture interval to be disabled", () => {
  assert.equal(
    shouldRunArchitectureReview({ commitsSinceReview: 100, interval: 0 }),
    false,
  );
});

test("builds a deterministic review file path", () => {
  assert.equal(
    architectureReviewPath({
      date: new Date("2026-10-24T12:00:00Z"),
      sha: "abcdef1234567890",
    }),
    "docs/architecture/reviews/2026-10-24-abcdef1.md",
  );
});

test("parses an approved architecture verdict", () => {
  const verdict = parseArchitectureVerdict(`
    Some notes from the architect.

    <architecture>
    {"decision":"approved","summary":"Boundaries hold.","followUps":[]}
    </architecture>
  `);

  assert.deepEqual(verdict, {
    decision: "approved",
    summary: "Boundaries hold.",
    followUps: [],
  });
});

test("parses a changes-requested verdict with follow-ups", () => {
  const verdict = parseArchitectureVerdict(`
    <architecture>
    {"decision":"changes_requested","summary":"The new service duplicates ownership of billing state.","followUps":["Extract a billing port","Add an ADR for the boundary"]}
    </architecture>
  `);

  assert.deepEqual(verdict, {
    decision: "changes_requested",
    summary: "The new service duplicates ownership of billing state.",
    followUps: ["Extract a billing port", "Add an ADR for the boundary"],
  });
});

test("defaults missing follow-ups to an empty list", () => {
  const verdict = parseArchitectureVerdict(
    '<architecture>{"decision":"approved","summary":"Fine."}</architecture>',
  );

  assert.deepEqual(verdict.followUps, []);
});

test("rejects a missing architecture tag", () => {
  assert.throws(
    () => parseArchitectureVerdict("I think it is fine."),
    /missing <architecture> block/i,
  );
});

test("rejects invalid architecture JSON", () => {
  assert.throws(
    () => parseArchitectureVerdict("<architecture>not json</architecture>"),
    /invalid architecture JSON/i,
  );
});

test("rejects an unknown decision", () => {
  assert.throws(
    () =>
      parseArchitectureVerdict(
        '<architecture>{"decision":"maybe","summary":"x","followUps":[]}</architecture>',
      ),
    /architecture decision/i,
  );
});

test("leaves a diff under the cap untouched", () => {
  const diff = "diff --git a/a.ts b/a.ts\n+export const a = 1;\n";

  assert.equal(truncateDiff(diff, 1000), diff);
});

test("truncates a large diff and reports what was omitted", () => {
  const diff = "x".repeat(500);

  const truncated = truncateDiff(diff, 100);

  assert.equal(truncated.startsWith("x".repeat(100)), true);
  assert.match(truncated, /truncated the diff/i);
  assert.match(truncated, /100 of 500 characters/i);
  assert.match(truncated, /400 omitted/i);
  assert.ok(truncated.length < diff.length);
});

test("maps verdicts to PR labels", () => {
  assert.equal(decisionLabel("approved"), "arch:approved");
  assert.equal(decisionLabel("changes_requested"), "arch:changes-requested");
});

test("formats prior decisions for the architect prompt", () => {
  assert.match(formatArchitectureHistory([]), /first architecture review/i);

  const text = formatArchitectureHistory([
    {
      branch: "softfac/12",
      fromSha: "aaaaaaaaaa",
      toSha: "bbbbbbbbbb",
      anchorSha: "bbbbbbbbbb",
      decision: "changes_requested",
      summary: "Split billing.",
      followUps: ["Extract a port", "Write an ADR"],
      reviewedAt: "2026-10-24T12:00:00Z",
    },
    {
      branch: "softfac/11",
      fromSha: null,
      toSha: "dddddddddd",
      anchorSha: "dddddddddd",
      decision: "approved",
      summary: "The boundary is coherent.",
      followUps: [],
      reviewedAt: "2026-10-23T12:00:00Z",
    },
  ]);

  assert.match(
    text,
    /- 2026-10-24 changes_requested on softfac\/12 \(aaaaaaa\.\.bbbbbbb\): Split billing\. Follow-ups: Extract a port; Write an ADR\./,
  );
  assert.match(
    text,
    /- 2026-10-23 approved on softfac\/11 \(initial\.\.ddddddd\): The boundary is coherent\./,
  );
});

test("keeps only follow-ups that were never raised before", () => {
  const prior: ArchitectureDecisionRecord[] = [
    {
      branch: "softfac/1",
      fromSha: null,
      toSha: "abc1234",
      anchorSha: "base1234",
      decision: "approved",
      summary: "Prior review.",
      followUps: ["Split the parser", "Add a metric"],
      reviewedAt: "2026-10-20T10:00:00.000Z",
    },
  ];

  assert.deepEqual(
    newFollowUps([" split the PARSER ", "Document the API", "document the api"], prior),
    ["Document the API"],
  );
});

test("keeps every follow-up when there is no history", () => {
  assert.deepEqual(newFollowUps(["a", "b"], []), ["a", "b"]);
});
