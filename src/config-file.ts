import { readFile } from "node:fs/promises";

import { parseConfig, type FactoryConfig } from "./config.js";

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadConfigFile(path: string): Promise<FactoryConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") {
      throw new Error(
        `config file not found at ${path}. Run "softfac init" first.`,
        { cause: error },
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid config JSON in ${path}`, { cause: error });
  }

  return parseConfig(parsed);
}
