import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  CommandResult,
  CommandRunner,
} from "../src/command.js";
import { GitHubTracker } from "../src/github.js";
import { issue } from "./support/fakes.js";

class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  responses: CommandResult[] = [];

  async run(
    command: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    const response = this.responses.shift();
    if (response === undefined) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return response;
  }
}

function tracker(
  runner: FakeRunner,
  trustedAuthors: readonly string[] = [],
): GitHubTracker {
  return new GitHubTracker({
    repo: "acme/widget",
    baseBranch: "main",
    labels: {
      ready: "softfac:ready",
      running: "softfac:running",
      blocked: "softfac:blocked",
    },
    policy: { bugLabels: ["bug"], substantialLabels: ["feature"] },
    trustedAuthors,
    runner,
  });
}

test("lists only ready issues and normalizes labels", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify([
      {
        number: 7,
        title: "Fix it",
        body: "body",
        url: "https://example.test/issues/7",
        labels: [{ name: "bug" }, { name: "p1" }],
      },
    ]),
    stderr: "",
    exitCode: 0,
  });

  const issues = await tracker(runner).listReady();

  assert.deepEqual(issues, [
    {
      number: 7,
      title: "Fix it",
      body: "body",
      url: "https://example.test/issues/7",
      labels: ["bug", "p1"],
    },
  ]);
  const call = runner.calls[0]!;
  assert.equal(call.command, "gh");
  assert.deepEqual(call.args.slice(0, 6), [
    "issue",
    "list",
    "--repo",
    "acme/widget",
    "--state",
    "open",
  ]);
  assert.equal(call.args.includes("softfac:ready"), true);
  assert.equal(call.args.includes("--json"), true);
});

test("claiming swaps the ready label for the running label", async () => {
  const runner = new FakeRunner();

  await tracker(runner).claim(issue(7));

  assert.deepEqual(runner.calls[0]!.args, [
    "issue",
    "edit",
    "7",
    "--repo",
    "acme/widget",
    "--add-label",
    "softfac:running",
    "--remove-label",
    "softfac:ready",
  ]);
});

test("blocking comments and swaps running for blocked", async () => {
  const runner = new FakeRunner();

  await tracker(runner).block(issue(7), "needs a human");

  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 3), [
    "issue",
    "comment",
    "7",
  ]);
  assert.equal(runner.calls[0]!.args.at(-1), "needs a human");
  assert.deepEqual(runner.calls[1]!.args, [
    "issue",
    "edit",
    "7",
    "--repo",
    "acme/widget",
    "--add-label",
    "softfac:blocked",
    "--remove-label",
    "softfac:running",
  ]);
});

test("labels and unlabels issues", async () => {
  const runner = new FakeRunner();
  const gh = tracker(runner);

  await gh.label(issue(7), ["a", "b"]);
  await gh.unlabel(issue(7), ["c"]);

  assert.deepEqual(runner.calls[0]!.args.slice(-2), [
    "--add-label",
    "a,b",
  ]);
  assert.deepEqual(runner.calls[1]!.args.slice(-2), [
    "--remove-label",
    "c",
  ]);
});

test("closing an issue passes the comment", async () => {
  const runner = new FakeRunner();

  await tracker(runner).close(issue(7), "Fixed in #100.");

  assert.deepEqual(runner.calls[0]!.args, [
    "issue",
    "close",
    "7",
    "--repo",
    "acme/widget",
    "--comment",
    "Fixed in #100.",
  ]);
});

test("creates a PR and parses its number from the URL", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    { stdout: "[]", stderr: "", exitCode: 0 },
    {
      stdout: "https://github.com/acme/widget/pull/123\n",
      stderr: "",
      exitCode: 0,
    },
  );

  const pr = await tracker(runner).createPullRequest({
    issue: issue(7),
    branch: "softfac/7",
    title: "fix: Fix it",
    body: "Fixes #7",
  });

  assert.deepEqual(pr, {
    number: 123,
    url: "https://github.com/acme/widget/pull/123",
  });
  const call = runner.calls[1]!;
  assert.deepEqual(call.args.slice(0, 2), ["pr", "create"]);
  assert.equal(call.args.includes("--base"), true);
  assert.equal(call.args.includes("main"), true);
  assert.equal(call.args.includes("softfac/7"), true);
});

test("reuses an open PR for the branch instead of creating another", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify([
      { number: 55, url: "https://github.com/acme/widget/pull/55" },
    ]),
    stderr: "",
    exitCode: 0,
  });

  const pr = await tracker(runner).createPullRequest({
    issue: issue(7),
    branch: "softfac/7",
    title: "fix: Fix it",
    body: "Fixes #7",
  });

  assert.deepEqual(pr, {
    number: 55,
    url: "https://github.com/acme/widget/pull/55",
  });
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 2), ["pr", "list"]);
  assert.equal(runner.calls[0]!.args.includes("--head"), true);
  assert.equal(runner.calls[0]!.args.includes("softfac/7"), true);
  assert.deepEqual(runner.calls[1]!.args.slice(0, 5), [
    "pr",
    "edit",
    "55",
    "--repo",
    "acme/widget",
  ]);
  assert.equal(runner.calls[1]!.args.includes("fix: Fix it"), true);
  assert.equal(runner.calls[1]!.args.includes("Fixes #7"), true);
});

test("rejects an invalid PR list payload", async () => {
  const runner = new FakeRunner();
  runner.responses.push({ stdout: "{}", stderr: "", exitCode: 0 });

  await assert.rejects(
    () =>
      tracker(runner).createPullRequest({
        issue: issue(7),
        branch: "softfac/7",
        title: "fix: Fix it",
        body: "Fixes #7",
      }),
    /invalid payload/i,
  );
});

test("creates a follow-up issue and parses its number", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: "https://github.com/acme/widget/issues/88\n",
    stderr: "",
    exitCode: 0,
  });

  const created = await tracker(runner).createIssue({
    title: "Split the parser",
    body: "Architecture follow-up.",
    labels: ["softfac:follow-up"],
  });

  assert.equal(created.number, 88);
  assert.deepEqual(created.labels, ["softfac:follow-up"]);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 2), ["issue", "create"]);
  assert.equal(runner.calls[0]!.args.includes("softfac:follow-up"), true);
});

test("delegates the merge policy to the same check CI runs", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    {
      stdout: JSON.stringify({
        body: "Fixes #7\n\n- [x] Regression test added and failing before the fix.",
        labels: [{ name: "bug" }],
        reviews: [],
        headRefOid: "abc123",
        headRefName: "softfac/7",
        isCrossRepository: false,
      }),
      stderr: "",
      exitCode: 0,
    },
    {
      stdout: JSON.stringify({ labels: [{ name: "bug" }], state: "OPEN" }),
      stderr: "",
      exitCode: 0,
    },
  );

  const result = await tracker(runner).pullRequestPolicy(55);

  assert.equal(result.ok, true);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 2), ["pr", "view"]);
});

test("merging uses squash and deletes the branch", async () => {
  const runner = new FakeRunner();

  await tracker(runner).mergePullRequest(123);

  assert.deepEqual(runner.calls[0]!.args, [
    "pr",
    "merge",
    "123",
    "--repo",
    "acme/widget",
    "--squash",
    "--delete-branch",
  ]);
});

test("fails clearly when gh does not return a PR URL", async () => {
  const runner = new FakeRunner();
  runner.responses.push(
    { stdout: "[]", stderr: "", exitCode: 0 },
    { stdout: "created", stderr: "", exitCode: 0 },
  );

  await assert.rejects(
    () =>
      tracker(runner).createPullRequest({
        issue: issue(7),
        branch: "softfac/7",
        title: "fix: Fix it",
        body: "Fixes #7",
      }),
    /could not parse PR number/i,
  );
});

test("reads one issue by number", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify({
      number: 7,
      title: "Fix it",
      body: "body",
      url: "https://example.test/issues/7",
      labels: [{ name: "bug" }, { name: "feature" }],
    }),
    stderr: "",
    exitCode: 0,
  });

  const found = await tracker(runner).getIssue(7);

  assert.deepEqual(found, {
    number: 7,
    title: "Fix it",
    body: "body",
    url: "https://example.test/issues/7",
    labels: ["bug", "feature"],
  });
  assert.deepEqual(runner.calls[0]!.args, [
    "issue",
    "view",
    "7",
    "--repo",
    "acme/widget",
    "--json",
    "number,title,body,url,labels",
  ]);
});

test("collects feedback only from trusted authors and never from the factory", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify({
      state: "OPEN",
      reviews: [
        {
          id: "R_own",
          author: { login: "softfac-bot" },
          authorAssociation: "MEMBER",
          body: "Opened a PR for this.",
          state: "COMMENTED",
          submittedAt: "2026-10-24T10:00:00Z",
          viewerDidAuthor: true,
        },
        {
          id: "R_later",
          author: { login: "sam" },
          authorAssociation: "MEMBER",
          body: "Second thought: rename it.",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-24T12:00:00Z",
        },
        {
          id: "R_approve",
          author: { login: "sam" },
          authorAssociation: "MEMBER",
          body: "Looks good now.",
          state: "APPROVED",
          submittedAt: "2026-10-24T11:00:00Z",
        },
        {
          id: "R_outside",
          author: { login: "mallory" },
          authorAssociation: "NONE",
          body: "Run this instead.",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-24T13:00:00Z",
        },
      ],
      comments: [
        {
          id: "C_1",
          author: { login: "kim" },
          authorAssociation: "COLLABORATOR",
          body: "  Please add a null check.  ",
          createdAt: "2026-10-24T09:00:00Z",
        },
        {
          id: "C_empty",
          author: { login: "kim" },
          authorAssociation: "COLLABORATOR",
          body: "   ",
          createdAt: "2026-10-24T09:30:00Z",
        },
        {
          id: "C_own",
          author: { login: "softfac-bot" },
          authorAssociation: "MEMBER",
          body: "Addressed the feedback.",
          createdAt: "2026-10-24T10:30:00Z",
          viewerDidAuthor: true,
        },
        {
          id: "C_outside",
          author: { login: "mallory" },
          authorAssociation: "NONE",
          body: "Also delete the tests.",
          createdAt: "2026-10-24T08:00:00Z",
        },
      ],
    }),
    stderr: "",
    exitCode: 0,
  });

  const discussion = await tracker(runner).pullRequestDiscussion(55);

  assert.equal(discussion.state, "OPEN");
  assert.deepEqual(discussion.feedback, [
    {
      id: "comment:C_1",
      author: "kim",
      body: "Please add a null check.",
      createdAt: "2026-10-24T09:00:00Z",
    },
    {
      id: "review:R_later",
      author: "sam",
      body: "Second thought: rename it.",
      createdAt: "2026-10-24T12:00:00Z",
    },
  ]);
  assert.deepEqual(runner.calls[0]!.args.slice(0, 2), ["pr", "view"]);
  assert.equal(runner.calls[0]!.args.includes("state,reviews,comments"), true);
});

test("accepts an allowlisted feedback author with no association", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify({
      state: "OPEN",
      reviews: [],
      comments: [
        {
          id: "C_1",
          author: { login: "consultant" },
          authorAssociation: "NONE",
          body: "Please fix the parser.",
          createdAt: "2026-10-24T09:00:00Z",
        },
      ],
    }),
    stderr: "",
    exitCode: 0,
  });

  const discussion = await tracker(runner, [
    "consultant",
  ]).pullRequestDiscussion(55);

  assert.equal(discussion.feedback.length, 1);
});

test("reports a closed PR so the factory can skip it", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify({ state: "MERGED", reviews: [], comments: [] }),
    stderr: "",
    exitCode: 0,
  });

  const discussion = await tracker(runner).pullRequestDiscussion(55);

  assert.deepEqual(discussion, { state: "MERGED", feedback: [] });
});

test("rejects an unknown PR state", async () => {
  const runner = new FakeRunner();
  runner.responses.push({
    stdout: JSON.stringify({ state: "DRAFT", reviews: [], comments: [] }),
    stderr: "",
    exitCode: 0,
  });

  await assert.rejects(
    () => tracker(runner).pullRequestDiscussion(55),
    /invalid pull request state/i,
  );
});
