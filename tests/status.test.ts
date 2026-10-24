import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../src/config.js";
import { createInitialState, type FactoryState, type IssueRecord } from "../src/state.js";
import { formatStatus } from "../src/status.js";

const config = parseConfig({ repo: "acme/widget", baseBranch: "main" });

function record(overrides: Partial<IssueRecord>): IssueRecord {
  return {
    number: 1,
    kind: "bug",
    branch: "softfac/1",
    status: "pending",
    updatedAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

function stateWith(records: readonly IssueRecord[]): FactoryState {
  const base = createInitialState(new Date("2026-10-24T12:00:00Z"));
  return {
    ...base,
    issues: Object.fromEntries(records.map((entry) => [String(entry.number), entry])),
  };
}

test("reports an empty factory", () => {
  const text = formatStatus(createInitialState(new Date("2026-10-24T12:00:00Z")), config);

  assert.match(text, /SoftFac status/);
  assert.match(text, /repo: acme\/widget -> main/);
  assert.match(text, /Issues \(0\)\n  none/);
  assert.match(text, /Sessions \(0\)\n  none/);
  assert.match(text, /anchor: none/);
  assert.match(text, /first architecture review/i);
});

test("lists issues with their branch and pull request", () => {
  const text = formatStatus(
    stateWith([
      record({
        number: 42,
        branch: "softfac/42",
        kind: "substantial",
        status: "pull-request",
        prNumber: 101,
      }),
      record({
        number: 41,
        branch: "softfac/41",
        kind: "bug",
        status: "done",
        prNumber: 100,
      }),
    ]),
    config,
  );

  assert.match(text, /#42\s+substantial\s+pull-request\s+PR #101 \(softfac\/42\)/);
  assert.match(text, /#41\s+bug\s+done\s+PR #100 \(softfac\/41\)/);
});

test("puts in-flight work before finished work", () => {
  const text = formatStatus(
    stateWith([
      record({ number: 1, status: "done" }),
      record({ number: 2, status: "reviewing" }),
      record({ number: 3, status: "blocked" }),
    ]),
    config,
  );

  const order = ["#2", "#3", "#1"].map((needle) => text.indexOf(needle));
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, text);
});

test("collapses a multi-line block reason onto one line", () => {
  const text = formatStatus(
    stateWith([
      record({
        number: 7,
        branch: "softfac/7",
        status: "blocked",
        lastError: "Review requested changes\n- Missing edge case\n- No test",
      }),
    ]),
    config,
  );

  assert.match(text, /#7\s+bug\s+blocked\s+softfac\/7 - Review requested changes - Missing edge case - No test/);
});

test("lists sessions and the architecture history", () => {
  const base = stateWith([record({ number: 5 })]);
  const text = formatStatus(
    {
      ...base,
      sessions: { "implementer:5": "impl-5", reviewer: "rev-1" },
      architecture: {
        lastReviewedBaseSha: "base1234567890",
        decisions: [
          {
            branch: "softfac/5",
            fromSha: null,
            toSha: "head1234567890",
            anchorSha: "base1234567890",
            decision: "approved",
            summary: "Boundaries hold.",
            followUps: [],
            reviewedAt: "2026-10-24T11:00:00.000Z",
          },
        ],
      },
    },
    config,
  );

  assert.match(text, /implementer:5 = impl-5/);
  assert.match(text, /reviewer = rev-1/);
  assert.match(text, /anchor: base1234567890/);
  assert.match(text, /decisions: 1/);
  assert.match(text, /approved on softfac\/5 \(initial\.\.head123\): Boundaries hold\./);
});
