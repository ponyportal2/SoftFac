import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly result: CommandResult;

  constructor(
    command: string,
    args: readonly string[],
    result: CommandResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(
      `${command} ${args.join(" ")} exited with ${result.exitCode}${
        detail === "" ? "" : `: ${detail.slice(0, 2000)}`
      }`,
    );
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

export class ProcessRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        windowsHide: true,
        shell: false,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", reject);
      child.on("close", (code) => {
        const result: CommandResult = {
          stdout,
          stderr,
          exitCode: code ?? 1,
        };
        if (result.exitCode !== 0) {
          reject(new CommandError(command, args, result));
          return;
        }
        resolve(result);
      });

      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  }
}
