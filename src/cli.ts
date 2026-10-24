#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { nextPollDelay } from "./backoff.js";
import { checkPullRequest } from "./check-pr.js";
import { ProcessRunner, type CommandRunner } from "./command.js";
import { loadConfigFile } from "./config-file.js";
import { issuePolicy, type FactoryConfig } from "./config.js";
import { initRepo } from "./init.js";
import { labelsForConfig, syncLabels } from "./labels.js";
import { acquireLock, type LockHandle } from "./lock.js";
import { parseRepoSlug } from "./repo-url.js";
import { createRuntime } from "./runtime.js";
import { FileStateStore } from "./state.js";
import { formatStatus } from "./status.js";
import type { ProcessResult } from "./factory.js";

const CONFIG_FILE = ".softfac/config.json";

const HELP = `SoftFac

Usage:
  softfac init [--repo owner/repo]
  softfac doctor
  softfac labels
  softfac status
  softfac run [--once]
  softfac check-pr <number> [--repair]

Commands:
  init       Create .softfac config, prompts, and review directories.
  doctor     Check config, the git repository, gh, pi, and the configured sandbox.
  labels     Create or update the required GitHub labels.
  status     Show recorded issues, sessions, and architecture decisions.
  run        Process ready issues and PR feedback continuously (or once with --once).
  check-pr   Enforce the PR policy; --repair reopens an issue closed by a bad PR.
`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

async function detectRepo(
  runner: CommandRunner,
  cwd: string,
): Promise<string | undefined> {
  const fromEnv = process.env["GITHUB_REPOSITORY"];
  if (fromEnv !== undefined) {
    return parseRepoSlug(fromEnv);
  }

  try {
    const result = await runner.run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd },
    );
    const parsed = parseRepoSlug(result.stdout);
    if (parsed !== undefined) {
      return parsed;
    }
  } catch {
    // gh may not be installed; fall back to the git remote.
  }

  try {
    const result = await runner.run(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd },
    );
    return parseRepoSlug(result.stdout);
  } catch {
    return undefined;
  }
}

function commandForPi(
  args: readonly string[],
): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd", args: ["/c", "pi", ...args] }
    : { command: "pi", args: [...args] };
}

async function initCommand(
  args: readonly string[],
  runner: CommandRunner,
  cwd: string,
): Promise<number> {
  const explicit = option(args, "--repo");
  if (explicit !== undefined && parseRepoSlug(explicit) === undefined) {
    console.error(`Invalid --repo value: ${explicit}`);
    return 1;
  }

  const repo =
    (explicit === undefined ? undefined : parseRepoSlug(explicit)) ??
    (await detectRepo(runner, cwd)) ??
    "OWNER/REPO";

  await initRepo({ repoPath: cwd, repo });
  console.log(`Created SoftFac scaffolding in ${join(cwd, ".softfac")}.`);
  if (repo === "OWNER/REPO") {
    console.log("Set config.repo in .softfac/config.json before running.");
  }
  console.log(
    "Next: review the prompts, run `softfac labels`, then run `softfac doctor`.",
  );
  return 0;
}

async function labelsCommand(
  config: FactoryConfig,
  runner: CommandRunner,
  cwd: string,
): Promise<number> {
  const repo =
    process.env["GITHUB_REPOSITORY"] ??
    (config.repo === "OWNER/REPO" ? "" : config.repo);
  if (repo === "") {
    console.error("Set config.repo or GITHUB_REPOSITORY before creating labels.");
    return 1;
  }

  const result = await syncLabels({
    repo,
    labels: labelsForConfig(config),
    runner,
    cwd,
  });
  for (const name of result.created) {
    console.log(`[ok]   ${name}`);
  }
  for (const name of result.existing) {
    console.log(`[skip] ${name} (already exists)`);
  }
  for (const failure of result.failed) {
    console.error(`[fail] ${failure.name}: ${failure.message}`);
  }
  return result.failed.length === 0 ? 0 : 1;
}

async function statusCommand(
  config: FactoryConfig,
  cwd: string,
): Promise<number> {
  const state = await new FileStateStore(
    join(cwd, config.statePath),
  ).read();
  process.stdout.write(formatStatus(state, config));
  return 0;
}

async function runDoctor(
  config: FactoryConfig,
  runner: CommandRunner,
  cwd: string,
): Promise<number> {
  let failures = 0;

  const check = async (
    label: string,
    action: () => Promise<unknown>,
    fatal = true,
  ): Promise<void> => {
    try {
      await action();
      console.log(`[ok]   ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[fail] ${label}: ${message}`);
      if (fatal) {
        failures += 1;
      }
    }
  };

  await check("config file", () => loadConfigFile(join(cwd, CONFIG_FILE)));
  await check("repo is configured", async () => {
    if (config.repo === "" || config.repo === "OWNER/REPO") {
      throw new Error("set config.repo to the GitHub owner/repo");
    }
  });
  await check("implementer prompt", () =>
    access(join(cwd, config.prompts.implementer)),
  );
  await check("reviewer prompt", () =>
    access(join(cwd, config.prompts.reviewer)),
  );
  await check("architect prompt", () =>
    access(join(cwd, config.prompts.architect)),
  );

  await check("git", () => runner.run("git", ["--version"], { cwd }));
  await check("git repository", () =>
    runner.run("git", ["rev-parse", "--show-toplevel"], { cwd }),
  );
  await check("git origin remote", () =>
    runner.run("git", ["remote", "get-url", "origin"], { cwd }),
  );
  await check("gh", () => runner.run("gh", ["--version"], { cwd }));
  await check("gh auth", () => runner.run("gh", ["auth", "status"], { cwd }));

  const pi = commandForPi(["--version"]);
  await check("pi", () => runner.run(pi.command, pi.args, { cwd }));

  if (config.sandbox === "docker") {
    await check("docker", () => runner.run("docker", ["info"], { cwd }));
    console.log(
      "[info] Sandcastle builds its Docker image during its own `init` flow.",
    );
  } else if (config.sandbox === "podman") {
    await check("podman", () => runner.run("podman", ["info"], { cwd }));
  } else {
    console.log("[warn] no-sandbox is configured; agents run on the host.");
  }

  return failures === 0 ? 0 : 1;
}

function printResult(result: ProcessResult): void {
  const pr = result.prNumber === undefined ? "" : ` PR #${result.prNumber}`;
  const reason = result.reason === undefined ? "" : `: ${result.reason}`;
  console.log(
    `#${result.issueNumber} ${result.kind} ${result.outcome}${pr} ` +
      `(${result.reviewRounds} review round(s), architecture ${result.architecture})${reason}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  args: readonly string[],
  config: FactoryConfig,
  cwd: string,
): Promise<number> {
  const once = hasFlag(args, "--once");
  const runtime = createRuntime(config, cwd);
  const lockPath = join(cwd, dirname(config.statePath), "run.lock");

  let lock: LockHandle;
  try {
    lock = await acquireLock(lockPath);
  } catch (error) {
    await runtime.close();
    console.error(
      `[softfac] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let failed = false;
  let stopping = false;
  let consecutiveFailures = 0;
  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`[softfac] ${signal} received; stopping after this cycle`);
  };
  const onSigint = (): void => stop("SIGINT");
  const onSigterm = (): void => stop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    do {
      try {
        const results = await runtime.factory.runOnce();
        consecutiveFailures = 0;
        if (results.length === 0) {
          console.log("[softfac] no ready issues");
        }
        for (const result of results) {
          printResult(result);
          if (result.outcome === "failed") {
            failed = true;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[softfac] run failed: ${message}`);
        failed = true;
        consecutiveFailures += 1;
        if (once) {
          break;
        }
      }

      if (!once && !stopping) {
        await sleep(nextPollDelay(consecutiveFailures, config.pollIntervalMs));
      }
    } while (!once && !stopping);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    try {
      await runtime.close();
    } finally {
      await lock.release();
    }
  }

  return failed ? 1 : 0;
}

async function checkPrCommand(
  args: readonly string[],
  config: FactoryConfig,
  runner: CommandRunner,
): Promise<number> {
  const raw = args[1];
  const prNumber = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("Usage: softfac check-pr <number>");
    return 1;
  }

  const repo =
    process.env["GITHUB_REPOSITORY"] ??
    (config.repo === "OWNER/REPO" ? "" : config.repo);
  if (repo === "") {
    console.error("Set config.repo or GITHUB_REPOSITORY before running check-pr.");
    return 1;
  }

  try {
    const result = await checkPullRequest({
      repo,
      prNumber,
      policy: issuePolicy(config),
      runner,
      repair: hasFlag(args, "--repair"),
    });
    if (result.reopened) {
      console.log(
        `Reopened issue #${result.issueNumber}: the PR does not satisfy the policy.`,
      );
    }
    if (result.ok) {
      console.log(
        `Policy passed for issue #${result.issueNumber} ` +
          `(${result.humanApprovals} human approval(s), ` +
          `architecture ${result.architectureApproved ? "approved" : "not required"}).`,
      );
      return 0;
    }

    console.error(`Policy failed for issue #${result.issueNumber}:`);
    for (const violation of result.violations) {
      console.error(`- [${violation.code}] ${violation.message}`);
    }
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function main(
  args: readonly string[],
  options: { readonly cwd?: string; readonly runner?: CommandRunner } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? new ProcessRunner();
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "version" || command === "--version") {
    console.log("softfac 0.1.0");
    return 0;
  }
  if (command === "init") {
    return initCommand(args, runner, cwd);
  }

  let config: FactoryConfig;
  try {
    config = await loadConfigFile(join(cwd, CONFIG_FILE));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (command === "doctor") {
    return runDoctor(config, runner, cwd);
  }
  if (command === "labels") {
    return labelsCommand(config, runner, cwd);
  }
  if (command === "status") {
    return statusCommand(config, cwd);
  }
  if (command === "run") {
    return runCommand(args, config, cwd);
  }
  if (command === "check-pr") {
    return checkPrCommand(args, config, runner);
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  return 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
