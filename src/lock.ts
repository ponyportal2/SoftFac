import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
}

export class LockError extends Error {
  readonly pid: number;

  constructor(path: string, pid: number) {
    super(
      `another SoftFac run is active (pid ${pid}); lock file: ${path}`,
    );
    this.name = "LockError";
    this.pid = pid;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(path: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removeLock(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function handle(path: string, pid: number): LockHandle {
  return {
    path,
    pid,
    async release() {
      if ((await readOwner(path)) !== pid) {
        return;
      }
      await removeLock(path);
    },
  };
}

export async function acquireLock(
  path: string,
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(path, `${pid}\n`, { encoding: "utf8", flag: "wx" });
      return handle(path, pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const owner = await readOwner(path);
    if (owner !== undefined && isAlive(owner)) {
      throw new LockError(path, owner);
    }
    await removeLock(path);
  }

  throw new LockError(path, (await readOwner(path)) ?? 0);
}
