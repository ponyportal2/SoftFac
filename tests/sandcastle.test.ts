import assert from "node:assert/strict";
import { test } from "node:test";

import { piAgent } from "../src/sandcastle.js";

test("builds an unquoted pi command on Windows", () => {
  const agent = piAgent(
    "openai-codex/gpt-6-luna",
    { thinking: "xhigh" },
    "win32",
  );

  const { command, stdin } = agent.buildPrintCommand({
    prompt: "hello",
    dangerouslySkipPermissions: false,
  });

  assert.equal(
    command,
    "pi -p --mode json --model openai-codex/gpt-6-luna --thinking xhigh",
  );
  assert.equal(stdin, "hello");
});

test("resumes a Windows session without quoting the id", () => {
  const agent = piAgent("openai-codex/gpt-6-luna", {}, "win32");

  const { command } = agent.buildPrintCommand({
    prompt: "hello",
    dangerouslySkipPermissions: false,
    resumeSession: "01a17f4d-3e63-761b-ba4d-e7fe26ab8e99",
  });

  assert.match(command, /--session 01a17f4d-3e63-761b-ba4d-e7fe26ab8e99$/);
});

test("leaves POSIX quoting to sandcastle", () => {
  const agent = piAgent("openai-codex/gpt-6-luna", {}, "linux");

  const { command } = agent.buildPrintCommand({
    prompt: "hello",
    dangerouslySkipPermissions: false,
  });

  assert.match(command, /--model 'openai-codex\/gpt-6-luna'/);
});
