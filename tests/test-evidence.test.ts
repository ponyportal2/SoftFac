import assert from "node:assert/strict";
import { test } from "node:test";

import { hasTestEvidence } from "../src/test-evidence.js";

const patterns = [
  "tests/**",
  "test/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
];

test("detects test files in common layouts", () => {
  assert.equal(hasTestEvidence(["tests/factory.test.ts"], patterns), true);
  assert.equal(hasTestEvidence(["test/test_factory.py"], patterns), true);
  assert.equal(hasTestEvidence(["src/factory.test.ts"], patterns), true);
  assert.equal(hasTestEvidence(["web/app.spec.tsx"], patterns), true);
  assert.equal(hasTestEvidence(["src/__tests__/factory.ts"], patterns), true);
});

test("ignores non-test files", () => {
  assert.equal(hasTestEvidence(["src/factory.ts"], patterns), false);
  assert.equal(hasTestEvidence(["docs/architecture/reviews/2026-10-24-abc.md"], patterns), false);
  assert.equal(hasTestEvidence([], patterns), false);
});

test("normalizes Windows path separators", () => {
  assert.equal(hasTestEvidence(["tests\\factory.test.ts"], patterns), true);
});

test("supports custom patterns and directory prefixes", () => {
  assert.equal(hasTestEvidence(["spec/factory_spec.rb"], ["spec/**"]), true);
  assert.equal(hasTestEvidence(["spec/factory_spec.rb"], ["tests/"]), false);
  assert.equal(hasTestEvidence(["tests/factory.ts"], ["tests/"]), true);
});

test("does not match a prefix without a glob", () => {
  assert.equal(hasTestEvidence(["tests-helper/factory.ts"], ["tests/**"]), false);
});
