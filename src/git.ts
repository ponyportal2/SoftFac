import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import {
  CommandError,
  ProcessRunner,
  type CommandRunner,
} from "./command.js";
import type { BaseBranchSync, GitOps, Issue } from "./ports.js";

export interface GitRepoOptions {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly worktreeForBranch?: (branch: string) => string | undefined;
  readonly runner?: CommandRunner;
}

export class GitRepo implements GitOps {
  readonly #repoPath: string;
  readonly #baseBranch: string;
  readonly #branchPrefix: string;
  readonly #worktreeForBranch: (branch: string) => string | undefined;
  readonly #runner: CommandRunner;

  constructor(options: GitRepoOptions) {
    this.#repoPath = options.repoPath;
    this.#baseBranch = options.baseBranch;
    this.#branchPrefix = options.branchPrefix;
    this.#worktreeForBranch = options.worktreeForBranch ?? (() => undefined);
    this.#runner = options.runner ?? new ProcessRunner();
  }

  async #git(args: readonly string[], cwd = this.#repoPath): Promise<string> {
    const result = await this.#runner.run("git", args, { cwd });
    return result.stdout;
  }

  async prepareBranch(issue: Issue): Promise<string> {
    return `${this.#branchPrefix}${issue.number}`;
  }

  async fetchBaseBranch(branch: string): Promise<BaseBranchSync> {
    await this.#git(["fetch", "origin", branch]);

    const remote = `origin/${branch}`;
    const remoteSha = (await this.#git(["rev-parse", remote])).trim();

    let localSha: string;
    try {
      localSha = (await this.#git(["rev-parse", `refs/heads/${branch}`])).trim();
    } catch (error) {
      if (error instanceof CommandError) {
        return {
          status: "skipped",
          reason: `no local ${branch} branch to fast-forward`,
        };
      }
      throw error;
    }

    if (localSha === remoteSha) {
      return { status: "up-to-date", sha: localSha };
    }
    if (!(await this.isAncestor(localSha, remote))) {
      return {
        status: "skipped",
        reason: `local ${branch} has commits that are not on ${remote}`,
      };
    }

    let current: string | undefined;
    try {
      current = (await this.#git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
    }

    if (current === branch) {
      try {
        await this.#git(["merge", "--ff-only", remote]);
      } catch (error) {
        if (error instanceof CommandError) {
          return {
            status: "skipped",
            reason: `could not fast-forward ${branch}: ${error.message}`,
          };
        }
        throw error;
      }
    } else {
      await this.#git(["update-ref", `refs/heads/${branch}`, remoteSha]);
    }

    return { status: "updated", from: localSha, to: remoteSha };
  }

  async countCommits(
    branch: string,
    sinceSha: string | null,
  ): Promise<number> {
    const range =
      sinceSha === null ? `${this.#baseBranch}..${branch}` : `${sinceSha}..${branch}`;
    const output = await this.#git(["rev-list", "--count", range]);
    const count = Number(output.trim());
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`git rev-list returned an invalid count: ${output.trim()}`);
    }
    return count;
  }

  async headSha(branch: string): Promise<string> {
    return (await this.#git(["rev-parse", branch])).trim();
  }

  async diff(branch: string, sinceSha: string | null): Promise<string> {
    const range =
      sinceSha === null
        ? `${this.#baseBranch}...${branch}`
        : `${sinceSha}...${branch}`;
    return this.#git(["diff", range]);
  }

  async changedFiles(
    branch: string,
    sinceSha: string | null,
  ): Promise<string[]> {
    const range =
      sinceSha === null
        ? `${this.#baseBranch}...${branch}`
        : `${sinceSha}...${branch}`;
    const output = await this.#git(["diff", "--name-only", range]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  async listFiles(branch: string): Promise<string[]> {
    const output = await this.#git(["ls-tree", "-r", "--name-only", branch]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  async isAncestor(ancestorSha: string, branch: string): Promise<boolean> {
    try {
      await this.#git(["merge-base", "--is-ancestor", ancestorSha, branch]);
      return true;
    } catch (error) {
      if (error instanceof CommandError && error.result.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  async push(branch: string): Promise<void> {
    const cwd = this.#worktreeForBranch(branch) ?? this.#repoPath;
    await this.#git(["push", "-u", "origin", branch], cwd);
  }

  async commitFile(
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    const worktree = this.#worktreeForBranch(branch);
    if (worktree === undefined) {
      throw new Error(`no worktree registered for branch ${branch}`);
    }

    const absolutePath = join(worktree, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");

    const gitPath = path.split(sep).join("/");
    await this.#git(["add", "--", gitPath], worktree);
    await this.#git(
      [
        "-c",
        "user.name=SoftFac",
        "-c",
        "user.email=softfac@localhost",
        "commit",
        "-m",
        message,
        "--",
        gitPath,
      ],
      worktree,
    );
  }
}
