import assert from "node:assert/strict";
import { test } from "node:test";

import { labelsForConfig, syncLabels } from "../src/labels.js";
import { defaultConfig } from "../src/config.js";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/command.js";

class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly existing = new Set<string>();
  readonly failures = new Map<string, string>();

  async run(
    command: string,
    args: readonly string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    const name = args[2] ?? "";
    const failure = this.failures.get(name);
    if (failure !== undefined) {
      throw new Error(failure);
    }
    if (this.existing.has(name)) {
      throw new Error(`label ${name} already exists`);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const label = {
  name: "softfac:ready",
  color: "0E8A16",
  description: "Ready for SoftFac",
};

test("includes factory, issue, and architecture labels", () => {
  const labels = labelsForConfig(defaultConfig()).map((label) => label.name);

  assert.deepEqual(labels, [
    "softfac:ready",
    "softfac:running",
    "softfac:blocked",
    "softfac:needs-human",
    "bug",
    "feature",
    "architecture",
    "epic",
    "arch:approved",
    "arch:changes-requested",
  ]);
});

test("uses configured label names", () => {
  const config = defaultConfig();
  const labels = labelsForConfig({
    ...config,
    labels: {
      ...config.labels,
      ready: "factory:go",
      substantial: ["large"],
    },
  }).map((label) => label.name);

  assert.equal(labels.includes("factory:go"), true);
  assert.equal(labels.includes("large"), true);
  assert.equal(labels.includes("softfac:ready"), false);
});

test("deduplicates labels", () => {
  const config = defaultConfig();
  const labels = labelsForConfig({
    ...config,
    labels: { ...config.labels, bug: "feature" },
  }).map((label) => label.name);

  assert.equal(labels.filter((name) => name === "feature").length, 1);
});

test("creates labels without forcing existing ones", async () => {
  const runner = new FakeRunner();

  const result = await syncLabels({
    repo: "acme/widget",
    labels: [label],
    runner,
  });

  assert.deepEqual(result, { created: [label.name], existing: [], failed: [] });
  assert.deepEqual(runner.calls[0]!.args, [
    "label",
    "create",
    "softfac:ready",
    "--repo",
    "acme/widget",
    "--color",
    "0E8A16",
    "--description",
    "Ready for SoftFac",
  ]);
  assert.equal(runner.calls[0]!.args.includes("--force"), false);
});

test("reports labels that already exist as skipped", async () => {
  const runner = new FakeRunner();
  runner.existing.add(label.name);

  const result = await syncLabels({
    repo: "acme/widget",
    labels: [label],
    runner,
  });

  assert.deepEqual(result, { created: [], existing: [label.name], failed: [] });
});

test("reports other label failures without stopping", async () => {
  const runner = new FakeRunner();
  runner.failures.set("bug", "HTTP 403: forbidden");
  const second = { name: "bug", color: "D73A4A", description: "A bug" };

  const result = await syncLabels({
    repo: "acme/widget",
    labels: [label, second],
    runner,
  });

  assert.deepEqual(result.created, [label.name]);
  assert.deepEqual(result.existing, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.name, "bug");
  assert.match(result.failed[0]!.message, /403/);
});
