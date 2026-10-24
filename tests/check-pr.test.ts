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

function prResponse(value: unknown): CommandResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

test("accepts a fully proven bug PR and ignores bot approvals", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 100,
      body: "Fixes #42\n\n- [x] Regression test added and failing before the fix.",
      labels: [{ name: "bug" }],
      reviews: [
        { state: "APPROVED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "dependabot[bot]" } },
      ],
    }),
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
  assert.equal(result.humanApprovals, 1);
  assert.equal(result.architectureApproved, false);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 5), [
    "pr",
    "view",
    "100",
    "--repo",
    "acme/widget",
  ]);
});

test("rejects a substantial PR without architecture or human approval", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 101,
      body: "Part of #10",
      labels: [{ name: "feature" }],
      reviews: [],
    }),
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
    [
      "substantial-missing-architecture-approval",
      "substantial-missing-human-approval",
    ],
  );
});

test("accepts a substantial PR with architecture and human approval", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 102,
      body: "Part of #10",
      labels: [{ name: "feature" }],
      reviews: [{ state: "APPROVED", author: { login: "alice" } }],
    }),
    prResponse({ labels: [{ name: "feature" }, { name: "arch:approved" }] }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 102,
    policy,
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.architectureApproved, true);
  assert.equal(result.humanApprovals, 1);
});

test("counts distinct human approvers only", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 103,
      body: "Part of #11",
      labels: [],
      reviews: [
        { state: "APPROVED", author: { login: "alice" } },
        { state: "APPROVED", author: { login: "alice" } },
        { state: "CHANGES_REQUESTED", author: { login: "bob" } },
        { state: "APPROVED", author: { login: "github-actions[bot]" } },
      ],
    }),
    prResponse({ labels: [] }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 103,
    policy,
    runner,
  });

  assert.equal(result.humanApprovals, 1);
});

test("reopens an issue closed by a PR that violates the policy", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 105,
      body: "Fixes #42\n\nNo regression test declared.",
      labels: [{ name: "bug" }],
      reviews: [],
    }),
    prResponse({ labels: [{ name: "bug" }], state: "CLOSED" }),
    { stdout: "", stderr: "", exitCode: 0 },
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 105,
    policy,
    runner,
    repair: true,
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
    prResponse({
      number: 106,
      body: "Fixes #42\n\n- [x] Regression test added and failing before the fix.",
      labels: [{ name: "bug" }],
      reviews: [],
    }),
    prResponse({ labels: [{ name: "bug" }], state: "CLOSED" }),
  );

  const result = await checkPullRequest({
    repo: "acme/widget",
    prNumber: 106,
    policy,
    runner,
    repair: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reopened, false);
  assert.equal(runner.calls.length, 2);
});

test("leaves a closed issue alone without --repair", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 107,
      body: "Fixes #42\n\nNo regression test declared.",
      labels: [{ name: "bug" }],
      reviews: [],
    }),
    prResponse({ labels: [{ name: "bug" }], state: "CLOSED" }),
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

test("fails when the PR body has no issue reference", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    prResponse({
      number: 104,
      body: "No reference",
      labels: [],
      reviews: [],
    }),
  );

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
