import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIssueReference } from "../src/issue-reference.js";

test("parses closing references", () => {
  assert.equal(parseIssueReference("Fixes #42"), 42);
  assert.equal(parseIssueReference("closes #7"), 7);
  assert.equal(parseIssueReference("Resolved #13"), 13);
});

test("parses partial references", () => {
  assert.equal(parseIssueReference("Part of #42"), 42);
  assert.equal(parseIssueReference("part of #9"), 9);
});

test("returns undefined without a reference", () => {
  assert.equal(parseIssueReference("No issue here"), undefined);
});

test("uses the first reference when several exist", () => {
  assert.equal(parseIssueReference("Fixes #42, part of #7"), 42);
});

test("does not match a bare issue number", () => {
  assert.equal(parseIssueReference("#42"), undefined);
});
