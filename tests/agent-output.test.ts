import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReviewOutput } from "../src/agent-output.js";

test("parses an approved review", () => {
  const verdict = parseReviewOutput(`
    Reviewed the diff.

    <review>
    {"verdict":"approved","summary":"The change is correct.","findings":[]}
    </review>
  `);

  assert.deepEqual(verdict, {
    verdict: "approved",
    summary: "The change is correct.",
    findings: [],
  });
});

test("parses a changes-requested review with findings", () => {
  const verdict = parseReviewOutput(`
    <review>
    {"verdict":"changes_requested","summary":"Missing edge case.","findings":["Empty input is not handled","No regression test"]}
    </review>
  `);

  assert.deepEqual(verdict, {
    verdict: "changes_requested",
    summary: "Missing edge case.",
    findings: ["Empty input is not handled", "No regression test"],
  });
});

test("defaults missing findings to an empty list", () => {
  const verdict = parseReviewOutput(
    '<review>{"verdict":"approved","summary":"Fine."}</review>',
  );

  assert.deepEqual(verdict.findings, []);
});

test("rejects a missing review tag", () => {
  assert.throws(
    () => parseReviewOutput("Looks fine."),
    /missing <review> block/i,
  );
});

test("rejects invalid review JSON", () => {
  assert.throws(
    () => parseReviewOutput("<review>not json</review>"),
    /invalid review JSON/i,
  );
});

test("rejects an unknown review verdict", () => {
  assert.throws(
    () =>
      parseReviewOutput(
        '<review>{"verdict":"lgtm","summary":"x","findings":[]}</review>',
      ),
    /review verdict/i,
  );
});

test("rejects a review without a summary", () => {
  assert.throws(
    () =>
      parseReviewOutput(
        '<review>{"verdict":"approved","summary":"","findings":[]}</review>',
      ),
    /review summary/i,
  );
});

test("rejects non-string review findings", () => {
  assert.throws(
    () =>
      parseReviewOutput(
        '<review>{"verdict":"approved","summary":"ok","findings":[1]}</review>',
      ),
    /review findings/i,
  );
});
