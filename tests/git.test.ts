import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  CommandError,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/command.js";
import { GitRepo } from "../src/git.js";
import { issue } from "./support/fakes.js";

const exec = promisify(execFile);

class FakeRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options: CommandOptions | undefined;
  }[] = [];
  stdout = "";
  failExitCode: number | undefined;
  handler:
    | ((args: readonly string[]) => { stdout?: string; exitCode?: number })
    | undefined;

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args], options });
    const scripted = this.handler?.(args);
    const result = {
      stdout: scripted?.stdout ?? this.stdout,
      stderr: "",
      exitCode: scripted?.exitCode ?? this.failExitCode ?? 0,
    };
    if (result.exitCode !== 0) {
      throw new CommandError(command, args, result);
    }
    return result;
  }
}

function fakeRepo(runner: FakeRunner): GitRepo {
  return new GitRepo({
    repoPath: "C:\\repo",
    baseBranch: "main",
    branchPrefix: "softfac/",
    runner,
  });
}

test("prepares a prefixed branch name", async () => {
  const runner = new FakeRunner();

  const branch = await fakeRepo(runner).prepareBranch(issue(7));

  assert.equal(branch, "softfac/7");
  assert.equal(runner.calls.length, 0);
});

test("lists the tracked files on a branch", async () => {
  const runner = new FakeRunner();
  runner.stdout = "src/a.ts\nsrc/b.ts\npackage.json\n";

  const files = await fakeRepo(runner).listFiles("softfac/7");

  assert.deepEqual(files, ["src/a.ts", "src/b.ts", "package.json"]);
  assert.deepEqual(runner.calls[0]!.args, [
    "ls-tree",
    "-r",
    "--name-only",
    "softfac/7",
  ]);
});

test("counts commits from the base branch when no review SHA exists", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).countCommits("softfac/7", null);

  assert.deepEqual(runner.calls[0]!.args, [
    "rev-list",
    "--count",
    "main..softfac/7",
  ]);
  assert.equal(runner.calls[0]!.options?.cwd, "C:\\repo");
});

test("counts commits since the last architecture review", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).countCommits("softfac/7", "abc123");

  assert.deepEqual(runner.calls[0]!.args, [
    "rev-list",
    "--count",
    "abc123..softfac/7",
  ]);
});

test("reads the branch head SHA", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).headSha("softfac/7");

  assert.deepEqual(runner.calls[0]!.args, ["rev-parse", "softfac/7"]);
});

test("diffs from the merge base initially", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).diff("softfac/7", null);

  assert.deepEqual(runner.calls[0]!.args, [
    "diff",
    "main...softfac/7",
  ]);
});

test("diffs since a review SHA when one exists", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).diff("softfac/7", "abc123");

  assert.deepEqual(runner.calls[0]!.args, [
    "diff",
    "abc123...softfac/7",
  ]);
});

test("pushes the branch to origin", async () => {
  const runner = new FakeRunner();

  await fakeRepo(runner).push("softfac/7");

  assert.deepEqual(runner.calls[0]!.args, [
    "push",
    "-u",
    "origin",
    "softfac/7",
  ]);
  assert.equal(runner.calls[0]!.options?.cwd, "C:\\repo");
});

test("fast-forwards the base branch when it is checked out", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") {
      return { stdout: "old1234\n" };
    }
    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return { stdout: "new5678\n" };
    }
    if (args[0] === "symbolic-ref") {
      return { stdout: "main\n" };
    }
    return {};
  };

  const result = await fakeRepo(runner).fetchBaseBranch("main");

  assert.deepEqual(result, {
    status: "updated",
    from: "old1234",
    to: "new5678",
  });
  assert.deepEqual(runner.calls[0]!.args, ["fetch", "origin", "main"]);
  assert.deepEqual(runner.calls.at(-1)!.args, [
    "merge",
    "--ff-only",
    "origin/main",
  ]);
});

test("moves the ref when the base branch is not checked out", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") {
      return { stdout: "old1234" };
    }
    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return { stdout: "new5678" };
    }
    if (args[0] === "symbolic-ref") {
      return { stdout: "softfac/7" };
    }
    return {};
  };

  await fakeRepo(runner).fetchBaseBranch("main");

  assert.deepEqual(runner.calls.at(-1)!.args, [
    "update-ref",
    "refs/heads/main",
    "new5678",
  ]);
});

test("leaves a diverged base branch alone", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") {
      return { stdout: "local999" };
    }
    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return { stdout: "remote999" };
    }
    if (args[0] === "merge-base") {
      return { exitCode: 1 };
    }
    return {};
  };

  const result = await fakeRepo(runner).fetchBaseBranch("main");

  assert.equal(result.status, "skipped");
  assert.match(
    result.status === "skipped" ? result.reason : "",
    /not on origin/,
  );
  assert.ok(!runner.calls.some((call) => call.args[0] === "merge"));
  assert.ok(!runner.calls.some((call) => call.args[0] === "update-ref"));
});

test("reports a failed fast-forward instead of throwing", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") {
      return { stdout: "old1234" };
    }
    if (args[0] === "rev-parse" && args[1] === "origin/main") {
      return { stdout: "new5678" };
    }
    if (args[0] === "symbolic-ref") {
      return { stdout: "main" };
    }
    if (args[0] === "merge") {
      return { exitCode: 1 };
    }
    return {};
  };

  const result = await fakeRepo(runner).fetchBaseBranch("main");

  assert.equal(result.status, "skipped");
  assert.match(
    result.status === "skipped" ? result.reason : "",
    /could not fast-forward main/,
  );
});

test("reports an already current base branch", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse") {
      return { stdout: "same1234" };
    }
    return {};
  };

  const result = await fakeRepo(runner).fetchBaseBranch("main");

  assert.deepEqual(result, { status: "up-to-date", sha: "same1234" });
  assert.equal(runner.calls.length, 3);
});

test("skips syncing when the local base branch does not exist", async () => {
  const runner = new FakeRunner();
  runner.handler = (args) => {
    if (args[0] === "rev-parse" && args[1] === "refs/heads/main") {
      return { exitCode: 128 };
    }
    if (args[0] === "rev-parse") {
      return { stdout: "new5678" };
    }
    return {};
  };

  const result = await fakeRepo(runner).fetchBaseBranch("main");

  assert.equal(result.status, "skipped");
});

test("fast-forwards a clone against a real remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "softfac-remote-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  const identity = ["-c", "user.name=SoftFac Test", "-c", "user.email=test@localhost"];

  try {
    await exec("git", ["init", "--bare", "-b", "main", remote]);
    await mkdir(seed);
    await exec("git", ["init", "-b", "main"], { cwd: seed });
    await writeFile(join(seed, "a.txt"), "one\n");
    await exec("git", ["add", "."], { cwd: seed });
    await exec("git", [...identity, "commit", "-m", "one"], { cwd: seed });
    await exec("git", ["remote", "add", "origin", remote], { cwd: seed });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: seed });

    await exec("git", ["clone", remote, clone]);

    await writeFile(join(seed, "b.txt"), "two\n");
    await exec("git", ["add", "."], { cwd: seed });
    await exec("git", [...identity, "commit", "-m", "two"], { cwd: seed });
    await exec("git", ["push", "origin", "main"], { cwd: seed });
    const upstream = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: seed })
    ).stdout.trim();

    const repo = new GitRepo({
      repoPath: clone,
      baseBranch: "main",
      branchPrefix: "softfac/",
    });

    const result = await repo.fetchBaseBranch("main");

    assert.equal(result.status, "updated");
    assert.equal(await repo.headSha("main"), upstream);
    assert.equal(await repo.headSha("origin/main"), upstream);
    assert.equal(
      (await readFile(join(clone, "b.txt"), "utf8")).trim(),
      "two",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commits a file into a registered worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "softfac-git-"));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "# test\n");
    await exec("git", ["add", "README.md"], { cwd: dir });
    await exec("git", ["commit", "-m", "initial"], { cwd: dir });
    await exec("git", ["checkout", "-b", "softfac/7"], { cwd: dir });

    const repo = new GitRepo({
      repoPath: dir,
      baseBranch: "main",
      branchPrefix: "softfac/",
      worktreeForBranch: (branch) =>
        branch === "softfac/7" ? dir : undefined,
    });

    await repo.commitFile(
      "softfac/7",
      "docs/reviews/7.md",
      "# Review\n",
      "arch: review issue 7",
    );

    const content = await readFile(
      join(dir, "docs/reviews/7.md"),
      "utf8",
    );
    assert.equal(content, "# Review\n");
    const { stdout } = await exec(
      "git",
      ["log", "-1", "--format=%s"],
      { cwd: dir },
    );
    assert.equal(stdout.trim(), "arch: review issue 7");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses to commit without a registered worktree", async () => {
  const runner = new FakeRunner();

  await assert.rejects(
    () =>
      fakeRepo(runner).commitFile(
        "softfac/7",
        "docs/reviews/7.md",
        "# Review\n",
        "arch: review",
      ),
    /no worktree registered/i,
  );
});

test("lists changed files from the merge base initially", async () => {
  const runner = new FakeRunner();
  runner.stdout = "src/a.ts\ntests/a.test.ts\n";

  const files = await fakeRepo(runner).changedFiles("softfac/7", null);

  assert.deepEqual(files, ["src/a.ts", "tests/a.test.ts"]);
  assert.deepEqual(runner.calls[0]!.args, [
    "diff",
    "--name-only",
    "main...softfac/7",
  ]);
});

test("lists changed files since a review SHA", async () => {
  const runner = new FakeRunner();
  runner.stdout = "src/a.ts\n";

  await fakeRepo(runner).changedFiles("softfac/7", "abc123");

  assert.deepEqual(runner.calls[0]!.args, [
    "diff",
    "--name-only",
    "abc123...softfac/7",
  ]);
});

test("reports whether a commit is an ancestor of a branch", async () => {
  const runner = new FakeRunner();

  assert.equal(await fakeRepo(runner).isAncestor("abc123", "softfac/7"), true);
  assert.deepEqual(runner.calls[0]!.args, [
    "merge-base",
    "--is-ancestor",
    "abc123",
    "softfac/7",
  ]);
});

test("returns false when git reports a non-ancestor", async () => {
  const runner = new FakeRunner();
  runner.failExitCode = 1;

  assert.equal(await fakeRepo(runner).isAncestor("abc123", "softfac/7"), false);
});

test("rethrows unexpected git ancestry errors", async () => {
  const runner = new FakeRunner();
  runner.failExitCode = 128;

  await assert.rejects(
    () => fakeRepo(runner).isAncestor("abc123", "softfac/7"),
    /exited with 128/,
  );
});
