import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initRepo } from "../src/init.js";

test("scaffolds config, prompts, and review directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-init-"));
  try {
    await initRepo({ repoPath: dir, repo: "acme/widget" });

    const config = JSON.parse(
      await readFile(join(dir, ".softfac/config.json"), "utf8"),
    ) as { repo: string; tdd: { testPatterns: string[] } };
    assert.equal(config.repo, "acme/widget");
    assert.equal(config.tdd.testPatterns.includes("tests/**"), true);

    const implementer = await readFile(
      join(dir, ".softfac/prompts/implementer.md"),
      "utf8",
    );
    assert.match(implementer, /\{\{ISSUE_NUMBER\}\}/);
    // Projects without a typecheck step should not be told to run one, and the
    // architect-owned path must read as one path, not a list of three words.
    assert.doesNotMatch(implementer, /typecheck/);
    assert.match(
      implementer,
      /Run the project's tests and any documented checks before you finish\./,
    );
    assert.match(implementer, /Do not edit `docs\/architecture\/reviews`/);
    const reviewer = await readFile(
      join(dir, ".softfac/prompts/reviewer.md"),
      "utf8",
    );
    assert.match(reviewer, /<review>/);
    const architect = await readFile(
      join(dir, ".softfac/prompts/architect.md"),
      "utf8",
    );
    assert.match(architect, /<architecture>/);
    assert.match(architect, /\{\{PRIOR_DECISIONS\}\}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not overwrite an existing config or prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-init-"));
  try {
    await initRepo({ repoPath: dir, repo: "acme/widget" });
    await writeFile(
      join(dir, ".softfac/config.json"),
      JSON.stringify({ repo: "custom/repo" }),
    );
    await writeFile(
      join(dir, ".softfac/prompts/reviewer.md"),
      "custom reviewer",
    );

    await initRepo({ repoPath: dir, repo: "other/repo" });

    const config = JSON.parse(
      await readFile(join(dir, ".softfac/config.json"), "utf8"),
    ) as { repo: string };
    assert.equal(config.repo, "custom/repo");
    assert.equal(
      await readFile(join(dir, ".softfac/prompts/reviewer.md"), "utf8"),
      "custom reviewer",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ignores softfac runtime state and logs once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-init-"));
  try {
    await initRepo({ repoPath: dir, repo: "acme/widget" });
    await initRepo({ repoPath: dir, repo: "acme/widget" });

    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    for (const pattern of [
      ".softfac/state.json",
      ".softfac/state.json.tmp",
      ".softfac/logs/",
      ".softfac/worktrees/",
    ]) {
      assert.equal(
        ignore.split(/\r?\n/).filter((line) => line === pattern).length,
        1,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("adds sandcastle worktrees to gitignore once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-init-"));
  try {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");

    await initRepo({ repoPath: dir, repo: "acme/widget" });
    await initRepo({ repoPath: dir, repo: "acme/widget" });

    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal(ignore.match(/^\.sandcastle\/$/gm)?.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
