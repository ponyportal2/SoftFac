import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireLock, LockError } from "../src/lock.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "softfac-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a second run is refused while the lock is held", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "run.lock");
    const lock = await acquireLock(path, { pid: 101 });

    await assert.rejects(
      () => acquireLock(path, { pid: 202, isAlive: () => true }),
      (error: unknown) =>
        error instanceof LockError && /pid 101/.test(error.message),
    );

    await lock.release();
  });
});

test("releasing the lock lets the next run start", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.lock");
    const first = await acquireLock(path, { pid: 101 });
    await first.release();

    const second = await acquireLock(path, { pid: 202 });

    assert.equal((await readFile(path, "utf8")).trim(), "202");
    await second.release();
  });
});

test("a lock left by a dead process is reclaimed", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.lock");
    await writeFile(path, "999999\n", "utf8");

    const lock = await acquireLock(path, {
      pid: 202,
      isAlive: () => false,
    });

    assert.equal((await readFile(path, "utf8")).trim(), "202");
    await lock.release();
  });
});

test("releasing does not delete a lock owned by another process", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "run.lock");
    const lock = await acquireLock(path, { pid: 101 });
    await writeFile(path, "202\n", "utf8");

    await lock.release();

    assert.equal((await readFile(path, "utf8")).trim(), "202");
  });
});
