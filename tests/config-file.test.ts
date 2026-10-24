import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfigFile } from "../src/config-file.js";

test("loads and parses a config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ repo: "acme/widget", baseBranch: "trunk" }),
    );

    const config = await loadConfigFile(path);

    assert.equal(config.repo, "acme/widget");
    assert.equal(config.baseBranch, "trunk");
    assert.equal(config.branchPrefix, "softfac/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails with an actionable message when config is missing", async () => {
  await assert.rejects(
    () => loadConfigFile("does-not-exist.json"),
    /config file not found.*softfac init/i,
  );
});

test("fails on invalid config JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, "not json");

    await assert.rejects(() => loadConfigFile(path), /invalid config JSON/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
