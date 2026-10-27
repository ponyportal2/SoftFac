import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { isEntryPoint } from "../src/cli.js";

test("recognizes the module's own path as the entry point", () => {
  const url = pathToFileURL(process.argv[1] ?? "").href;
  assert.equal(isEntryPoint(process.argv[1], url), true);
});

test("rejects another file and a missing path", () => {
  const url = pathToFileURL(join(tmpdir(), "softfac-cli-real.js")).href;
  assert.equal(isEntryPoint(join(tmpdir(), "softfac-cli-other.js"), url), false);
  assert.equal(isEntryPoint(undefined, url), false);
});

test("recognizes the entry point through a symlink", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "softfac-cli-"));
  const real = join(dir, "cli.js");
  const link = join(dir, "cli-link.js");
  writeFileSync(real, "");
  try {
    symlinkSync(real, link);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    t.skip("file symlinks are not available on this platform");
    return;
  }
  try {
    assert.equal(isEntryPoint(link, pathToFileURL(real).href), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
