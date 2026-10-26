import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPullRequest } from "../src/check-pr.js";
import type {
  CommandResult,
  CommandRunner,
} from "../src/command.js";

class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  responses: CommandResult[] = [];

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("unexpected command");
    }
    return response;
  }
}

const policy = {
  bugLabels: ["bug"],
  substantialLabels: ["feature"],
};

const repair = {
  branchPrefix: "softfac/",
  managedLabels: ["softfac:running"],
};

function prResponse(value: unknown): CommandResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

function prPayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: "Part of #42",
    labels: [],
    headRefName: "softfac/42",
    isCrossRepository: false,
    ...patch,
  };
}

test("accepts a fully proven bug PR", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\n- [x] Regression test added and failing before the fix.",
        labels: [{ name: "bug" }],
      }),
    ),
    prResponse({ labels: [{ name: "bug" }] }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 100,
    policy,
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 42);
  assert.equal(result.architectureApproved, false);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 5), [
    "pr",
    "view",
    "100",
    "--repo",
    "acme/widget",
  ]);
  const jsonFields =
    runner.calls[0]!.args[runner.calls[0]!.args.indexOf("--json") + 1];
  assert.equal(jsonFields, "body,labels,headRefName,isCrossRepository");
});

test("rejects a substantial PR without architecture approval", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(prPayload({ body: "Part of #10", labels: [{ name: "feature" }] })),
    prResponse({ labels: [{ name: "feature" }] }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 101,
    policy,
    runner,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["substantial-missing-architecture-approval"],
  );
});

test("accepts a substantial PR with architecture approval", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(prPayload({ body: "Part of #10", labels: [{ name: "feature" }] })),
    prResponse({
      labels: [{ name: "feature" }, { name: "arch:approved" }],
    }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 102,
    policy,
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.architectureApproved, true);
});

test("reopens an issue closed by a PR that violates the policy", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\nNo regression test declared.",
        labels: [{ name: "bug" }],
      }),
    ),
    prResponse({
      labels: [{ name: "bug" }, { name: "softfac:running" }],
      state: "CLOSED",
    }),
    { stdout: "", stderr: "", exitCode: 0 },
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 105,
    policy,
    runner,
    repair,
  });

  assert.equal(result.ok, false);
  assert.equal(result.issueState, "CLOSED");
  assert.equal(result.reopened, true);
  assert.deepEqual(runner.calls[2]!.args, [
    "issue",
    "reopen",
    "42",
    "--repo",
    "acme/widget",
  ]);
});

test("does not reopen a closed issue when the policy passes", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\n- [x] Regression test added and failing before the fix.",
        labels: [{ name: "bug" }],
      }),
    ),
    prResponse({
      labels: [{ name: "bug" }, { name: "softfac:running" }],
      state: "CLOSED",
    }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 106,
    policy,
    runner,
    repair,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("leaves a closed issue alone without --repair", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\nNo regression test declared.",
        labels: [{ name: "bug" }],
      }),
    ),
    prResponse({
      labels: [{ name: "bug" }, { name: "softfac:running" }],
      state: "CLOSED",
    }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 107,
    policy,
    runner,
  });

  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("does not reopen an issue for a branch the factory does not own", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\nNo regression test declared.",
        labels: [{ name: "bug" }],
        headRefName: "feature/42",
      }),
    ),
    prResponse({
      labels: [{ name: "bug" }, { name: "softfac:running" }],
      state: "CLOSED",
    }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 112,
    policy,
    runner,
    repair,
  });

  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("does not reopen an issue for a cross-repository PR", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\nNo regression test declared.",
        labels: [{ name: "bug" }],
        isCrossRepository: true,
      }),
    ),
    prResponse({
      labels: [{ name: "bug" }, { name: "softfac:running" }],
      state: "CLOSED",
    }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 113,
    policy,
    runner,
    repair,
  });

  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("does not reopen an issue the factory does not manage", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse(
      prPayload({
        body: "Fixes #42\n\nNo regression test declared.",
        labels: [{ name: "bug" }],
      }),
    ),
    prResponse({ labels: [{ name: "bug" }], state: "CLOSED" }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 114,
    policy,
    runner,
    repair,
  });

  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("fails when the PR body has no issue reference", async () => {
  const runner = new FakeRunner();
  runner.responses.push(prResponse(prPayload({ body: "No reference" })));

  await assert.rejects(
    () =>
      checkPullRequest({
        repo: "acme/widget",
        prNumber: 104,
        policy,
        runner,
      }),
    /must reference an issue/i,
  );
});
