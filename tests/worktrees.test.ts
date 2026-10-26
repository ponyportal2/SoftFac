import assert from "node:assert/strict";
import { test } from "node:test";

import { WorktreeRegistry } from "../src/worktrees.js";

test("records and resolves a branch worktree", () => {
  const registry = new WorktreeRegistry();
  registry.set("softfac/7", "C:\\worktrees\\7");

  assert.equal(registry.get("softfac/7"), "C:\\worktrees\\7");
  assert.equal(registry.get("softfac/8"), undefined);
});

test("replaces an existing worktree path", () => {
  const registry = new WorktreeRegistry();
  registry.set("softfac/7", "old");
  registry.set("softfac/7", "new");

  assert.equal(registry.get("softfac/7"), "new");
  assert.deepEqual(registry.branches(), ["softfac/7"]);
});

test("deletes a recorded worktree", () => {
  const registry = new WorktreeRegistry();
  registry.set("softfac/7", "path");

  registry.delete("softfac/7");

  assert.equal(registry.get("softfac/7"), undefined);
  assert.deepEqual(registry.branches(), []);
});
