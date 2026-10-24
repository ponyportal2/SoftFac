import { readFile } from "node:fs/promises";

export type PromptArgs = Record<string, string | number | boolean>;

export function renderPrompt(template: string, args: PromptArgs): string {
  return template.replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (_match, key: string) => {
      if (!Object.hasOwn(args, key)) {
        throw new Error(`missing prompt argument: ${key}`);
      }
      return String(args[key]);
    },
  );
}

export async function loadPrompt(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function loadRenderedPrompt(
  path: string,
  args: PromptArgs,
): Promise<string> {
  return renderPrompt(await loadPrompt(path), args);
}
