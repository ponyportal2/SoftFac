import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultConfig,
  parseConfig,
} from "../src/config.js";

test("provides defaults for an empty config", () => {
  const config = parseConfig({});

  assert.equal(config.baseBranch, "main");
  assert.equal(config.branchPrefix, "softfac/");
  assert.equal(config.labels.ready, "softfac:ready");
  assert.equal(config.labels.running, "softfac:running");
  assert.equal(config.labels.blocked, "softfac:blocked");
  assert.equal(config.labels.needsHuman, "softfac:needs-human");
  assert.equal(config.architecture.everyCommits, 10);
  assert.equal(config.review.maxRounds, 2);
  assert.equal(config.bugs.autoClose, true);
  assert.equal(config.bugs.autoMerge, true);
  assert.equal(config.maxIssuesPerRun, 1);
  assert.equal(config.sandbox, "docker");
  assert.equal(config.agents.implementerModel, "claude-sonnet-4-6");
  assert.equal(config.agents.reviewerModel, "claude-sonnet-4-6");
  assert.equal(config.agents.architectModel, "claude-opus-4-8");
  assert.deepEqual(config.tdd.testPatterns, [
    "tests/**",
    "test/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
  ]);
});

test("allows overriding the test file patterns", () => {
  const config = parseConfig({ tdd: { testPatterns: ["spec/**"] } });

  assert.deepEqual(config.tdd.testPatterns, ["spec/**"]);
});

test("verification is disabled by default", () => {
  assert.deepEqual(parseConfig({}).verification.commands, []);
});

test("accepts verification commands", () => {
  const config = parseConfig({
    verification: { commands: ["npm ci", "npm test"] },
  });

  assert.deepEqual(config.verification.commands, ["npm ci", "npm test"]);
});

test("rejects a non-array verification command list", () => {
  assert.throws(
    () => parseConfig({ verification: { commands: "npm test" } }),
    /verification\.commands/i,
  );
});

test("rejects an empty verification command", () => {
  assert.throws(
    () => parseConfig({ verification: { commands: [""] } }),
    /verification\.commands/i,
  );
});

test("rejects an empty test pattern list", () => {
  assert.throws(
    () => parseConfig({ tdd: { testPatterns: [] } }),
    /testPatterns/i,
  );
});

test("defaultConfig returns a fresh copy", () => {
  const first = defaultConfig();
  const second = defaultConfig();
  (first.labels as { ready: string }).ready = "changed";
  assert.equal(second.labels.ready, "softfac:ready");
});

test("merges nested overrides", () => {
  const config = parseConfig({
    repo: "acme/widget",
    baseBranch: "trunk",
    architecture: { everyCommits: 25 },
    labels: { ready: "factory:go" },
    bugs: { autoMerge: false },
    sandbox: "no-sandbox",
  });

  assert.equal(config.repo, "acme/widget");
  assert.equal(config.baseBranch, "trunk");
  assert.equal(config.architecture.everyCommits, 25);
  assert.equal(config.labels.ready, "factory:go");
  assert.equal(config.labels.running, "softfac:running");
  assert.equal(config.bugs.autoMerge, false);
  assert.equal(config.bugs.autoClose, true);
  assert.equal(config.sandbox, "no-sandbox");
});

test("rejects an unknown sandbox", () => {
  assert.throws(
    () => parseConfig({ sandbox: "firecracker" }),
    /sandbox/i,
  );
});

test("defaults and overrides the architecture diff cap", () => {
  assert.equal(parseConfig({}).architecture.maxDiffChars, 60_000);
  assert.equal(
    parseConfig({ architecture: { maxDiffChars: 5_000 } }).architecture
      .maxDiffChars,
    5_000,
  );
});

test("rejects a non-positive architecture diff cap", () => {
  assert.throws(
    () => parseConfig({ architecture: { maxDiffChars: 0 } }),
    /maxDiffChars/i,
  );
});

test("rejects a negative architecture interval", () => {
  assert.throws(
    () => parseConfig({ architecture: { everyCommits: -1 } }),
    /everyCommits/i,
  );
});

test("rejects a negative review round count", () => {
  assert.throws(
    () => parseConfig({ review: { maxRounds: -1 } }),
    /maxRounds/i,
  );
});

test("rejects a non-positive issue limit", () => {
  assert.throws(
    () => parseConfig({ maxIssuesPerRun: 0 }),
    /maxIssuesPerRun/i,
  );
});
