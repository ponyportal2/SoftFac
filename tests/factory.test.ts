import assert from "node:assert/strict";
import { test } from "node:test";

import type { ArchitectureDecisionRecord } from "../src/architecture.js";
import { parseConfig } from "../src/config.js";
import { Factory } from "../src/factory.js";
import type { IssueRecord } from "../src/state.js";
import { issue, FakeAgents, FakeGit, FakeTracker, MemoryStateStore } from "./support/fakes.js";

function setup(
  issues: ReturnType<typeof issue>[],
  overrides: Record<string, unknown> = {},
) {
  const config = parseConfig({
    repo: "acme/widget",
    architecture: { everyCommits: 10 },
    ...overrides,
  });
  const tracker = new FakeTracker(issues);
  const git = new FakeGit(config.branchPrefix);
  const agents = new FakeAgents();
  const state = new MemoryStateStore();
  const sleeps: number[] = [];
  const factory = new Factory({
    config,
    tracker,
    git,
    agents,
    state,
    now: () => new Date("2026-10-24T12:00:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { config, tracker, git, agents, state, factory, sleeps };
}

test("a bug is implemented, reviewed, merged, and auto-closed", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, git, agents, state, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  git.head = "verified-head-42";
  agents.implementResults = [
    { sessionId: "impl-42", commits: 1, stdout: "implemented" },
  ];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "Regression is covered.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "done");
  assert.equal(result.reviewRounds, 1);
  assert.equal(result.architecture, "skipped");
  assert.equal(tracker.pullRequests.length, 1);
  assert.match(tracker.pullRequests[0]!.body, /Fixes #42/);
  assert.match(tracker.pullRequests[0]!.body, /Regression test added/i);
  assert.deepEqual(tracker.merges, [101]);
  assert.deepEqual(tracker.mergeHeads, ["verified-head-42"]);
  assert.equal(tracker.closes.length, 1);
  assert.equal(
    tracker.labels.some((entry) => entry.labels.includes("softfac:needs-human")),
    false,
  );
  assert.equal(git.branches[0], "softfac/42");
  assert.deepEqual(git.pushes, ["softfac/42"]);
  assert.equal(state.state.sessions["implementer:42"], "impl-42");
  assert.equal(state.state.sessions["reviewer:bug"], "rev-1");
  assert.equal(state.state.issues["42"]!.status, "done");
});

test("refuses to merge a bug when the live PR fails the policy", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  tracker.policyResult = {
    ok: false,
    violations: [
      {
        code: "bug-missing-regression-test",
        message: "Bug PRs must check the regression-test box.",
      },
    ],
  };

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.prNumber, 101);
  assert.deepEqual(tracker.policyChecks, [101]);
  assert.deepEqual(tracker.merges, []);
  assert.equal(tracker.closes.length, 0);
  assert.match(tracker.blocks[0]!.reason, /Refusing to auto-merge PR #101/);
  assert.match(tracker.blocks[0]!.reason, /bug-missing-regression-test/);
});

test("does not merge when the policy check itself fails", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  tracker.policyError = new Error("gh pr view failed");

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.deepEqual(tracker.merges, []);
  assert.match(tracker.blocks[0]!.reason, /policy check failed: gh pr view failed/);
});

test("a merge refused because the head moved blocks the issue", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, agents, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  agents.implementResults = [
    { sessionId: "impl-42", commits: 1, stdout: "implemented" },
  ];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "Regression is covered.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];
  tracker.mergeError = new Error("Head commit changed since verification");

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.deepEqual(tracker.merges, []);
  assert.equal(tracker.closes.length, 0);
  assert.match(tracker.blocks[0]!.reason, /Refusing to auto-merge PR #101/);
  assert.match(tracker.blocks[0]!.reason, /at verified head/);
  assert.match(tracker.blocks[0]!.reason, /merge failed: Head commit changed/);
});

test("gives the architect the repository context", async () => {
  const target = issue(42, ["feature"]);
  const { git, agents, factory } = setup([target]);
  git.fileList = [
    "src/factory.ts",
    "tests/factory.test.ts",
    "docs/adr/0001-ports.md",
    "package.json",
  ];
  git.fileContents.set("docs/adr/0001-ports.md", "Ports are the only seam.");
  agents.architectResults = [
    {
      verdict: { decision: "approved", summary: "Fine.", followUps: [] },
      stdout: "",
    },
  ];

  await factory.processIssue(target);

  const context = agents.architectCalls[0]!.repositoryContext;
  assert.match(context, /Changed files \(2\)/);
  assert.match(context, /Module inventory:[\s\S]*- src: 1 file/);
  assert.match(context, /docs\/adr\/0001-ports\.md/);
  assert.match(context, /package\.json/);
  assert.match(context, /Ports are the only seam\./);
  assert.deepEqual(git.readFileCalls, ["docs/adr/0001-ports.md"]);
});

test("keeps reviewer sessions per issue area", async () => {
  const bug = issue(42, ["bug"]);
  const feature = issue(43, ["feature"]);
  const { agents, state, factory } = setup([bug, feature]);
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "Bug is fixed.",
      findings: [],
      sessionId: "rev-bug",
      commits: 0,
    },
    {
      verdict: "approved",
      summary: "Feature is fine.",
      findings: [],
      sessionId: "rev-feature",
      commits: 0,
    },
  ];

  await factory.processIssue(bug);
  await factory.processIssue(feature);

  assert.equal(state.state.sessions["reviewer:bug"], "rev-bug");
  assert.equal(state.state.sessions["reviewer:feature"], "rev-feature");
  assert.equal(state.state.sessions["reviewer"], undefined);
});

test("files new architecture follow-ups as issues", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, git, agents, state, factory } = setup([target]);
  agents.architectResults = [
    {
      verdict: {
        decision: "approved",
        summary: "Boundaries hold.",
        followUps: ["Split the parser", "Add an ADR for the boundary"],
      },
      stdout: "",
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.architecture, "approved");
  assert.equal(tracker.createdIssues.length, 2);
  assert.equal(tracker.createdIssues[0]!.title, "Split the parser");
  assert.deepEqual(tracker.createdIssues[0]!.labels, ["softfac:follow-up"]);
  assert.match(tracker.createdIssues[0]!.body, /review of #42/);
  assert.match(git.files[0]!.content, /Split the parser \(filed as #900\)/);
  assert.deepEqual(state.state.architecture.decisions[0]!.filedFollowUps, [
    { text: "Split the parser", number: 900 },
    { text: "Add an ADR for the boundary", number: 901 },
  ]);
});

test("does not re-file a follow-up raised by an earlier review", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, agents, state, factory } = setup([target]);
  const prior: ArchitectureDecisionRecord = {
    branch: "softfac/1",
    fromSha: null,
    toSha: "abc1234",
    anchorSha: "base1234",
    decision: "approved",
    summary: "Prior review.",
    followUps: ["Split the parser"],
    reviewedAt: "2026-10-20T10:00:00.000Z",
  };
  state.state = {
    ...state.state,
    architecture: {
      ...state.state.architecture,
      decisions: [prior],
    },
  };
  agents.architectResults = [
    {
      verdict: {
        decision: "approved",
        summary: "Boundaries hold.",
        followUps: ["Split the parser", "Document the API"],
      },
      stdout: "",
    },
  ];

  await factory.processIssue(target);

  assert.equal(tracker.createdIssues.length, 1);
  assert.equal(tracker.createdIssues[0]!.title, "Document the API");
});

test("a failed follow-up issue does not block the pull request", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, agents, factory } = setup([target]);
  tracker.createIssueError = new Error("gh is down");
  agents.architectResults = [
    {
      verdict: {
        decision: "approved",
        summary: "Boundaries hold.",
        followUps: ["Split the parser"],
      },
      stdout: "",
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "pull-request");
  assert.equal(tracker.createdIssues.length, 0);
});

test("syncs the base branch before the implementer runs", async () => {
  const target = issue(42, ["feature"]);
  const { git, agents, factory } = setup([target]);
  let implementedBeforeSync = false;
  git.onSync = () => {
    implementedBeforeSync = agents.implementCalls.length > 0;
  };
  git.baseSync = { status: "updated", from: "old1234", to: "new5678" };

  await factory.processIssue(target);

  assert.deepEqual(git.baseSyncCalls, ["main"]);
  assert.equal(implementedBeforeSync, false);
});

test("continues when the base branch cannot be fast-forwarded", async () => {
  const target = issue(42, ["feature"]);
  const { git, factory } = setup([target]);
  git.baseSync = {
    status: "skipped",
    reason: "local main has commits that are not on origin/main",
  };

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "pull-request");
});

test("requeues issues left in flight by a previous run", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, state, factory } = setup([target]);
  state.state = {
    ...state.state,
    issues: {
      "42": {
        number: 42,
        status: "reviewing",
        kind: "substantial",
        branch: "softfac/42",
        updatedAt: "2026-10-24T11:00:00.000Z",
      },
    },
  };

  const recovered = await factory.recoverInterrupted();

  assert.equal(recovered, 1);
  assert.deepEqual(tracker.requeues, [42]);
  assert.equal(state.state.issues["42"]!.status, "pending");
});

test("leaves finished issues alone during recovery", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, state, factory } = setup([target]);
  state.state = {
    ...state.state,
    issues: {
      "42": {
        number: 42,
        status: "pull-request",
        kind: "substantial",
        branch: "softfac/42",
        prNumber: 101,
        updatedAt: "2026-10-24T11:00:00.000Z",
      },
    },
  };

  assert.equal(await factory.recoverInterrupted(), 0);
  assert.deepEqual(tracker.requeues, []);
  assert.equal(state.state.issues["42"]!.status, "pull-request");
});

test("resets an interrupted feedback run without requeueing the issue", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, state, factory } = setup([target]);
  state.state = {
    ...state.state,
    issues: {
      "42": {
        number: 42,
        kind: "substantial",
        status: "feedback",
        branch: "softfac/42",
        prNumber: 101,
        updatedAt: "2026-10-24T11:00:00.000Z",
      },
    },
  };

  const recovered = await factory.recoverInterrupted();

  // Only requeued issues can vanish from listReady while the label index
  // catches up; a feedback record stays in the review pile.
  assert.equal(recovered, 0);
  assert.deepEqual(tracker.requeues, []);
  assert.equal(state.state.issues["42"]!.status, "pull-request");
  assert.equal(state.state.issues["42"]!.prNumber, 101);
});

test("runOnce recovers interrupted work before claiming", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, state, factory } = setup([target]);
  state.state = {
    ...state.state,
    issues: {
      "42": {
        number: 42,
        status: "architecture",
        kind: "substantial",
        branch: "softfac/42",
        updatedAt: "2026-10-24T11:00:00.000Z",
      },
    },
  };
  let claimedBeforeRequeue = false;
  tracker.onRequeue = () => {
    claimedBeforeRequeue = tracker.claims.length > 0;
  };

  const results = await factory.runOnce();

  assert.equal(claimedBeforeRequeue, false);
  assert.deepEqual(tracker.requeues, [42]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.outcome, "pull-request");
});

test("retries the ready list when the label index lags a requeue", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, state, factory, sleeps } = setup([target]);
  state.state = {
    ...state.state,
    issues: {
      "42": {
        number: 42,
        status: "running",
        kind: "substantial",
        branch: "softfac/42",
        updatedAt: "2026-10-24T11:00:00.000Z",
      },
    },
  };
  const ready = tracker.listReady.bind(tracker);
  let lists = 0;
  tracker.listReady = async () => {
    lists += 1;
    return lists === 1 ? [] : ready();
  };

  const results = await factory.runOnce();

  assert.equal(lists, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.outcome, "pull-request");
});

test("releases the worktree when the issue finishes", async () => {
  const target = issue(42, ["bug"]);
  const { agents, factory } = setup([target]);

  await factory.processIssue(target);

  assert.deepEqual(agents.released, ["softfac/42"]);
});

test("releases the worktree when the issue is blocked", async () => {
  const target = issue(42, ["feature"]);
  const { agents, factory } = setup([target]);
  const changesRequested = {
    verdict: "changes_requested" as const,
    summary: "Not yet.",
    findings: ["Missing edge case"],
    commits: 0,
  };
  agents.reviewResults = [
    changesRequested,
    changesRequested,
    changesRequested,
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.deepEqual(agents.released, ["softfac/42"]);
});

test("releases the worktree when the implementer throws", async () => {
  const target = issue(42, ["bug"]);
  const { agents, factory } = setup([target]);
  agents.implementError = new Error("pi crashed");

  await assert.rejects(() => factory.processIssue(target), /pi crashed/);

  assert.deepEqual(agents.released, ["softfac/42"]);
});

test("an auto-close failure does not undo a merged bug", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  tracker.closeError = new Error("issue is already closed");

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "done");
  assert.deepEqual(tracker.merges, [101]);
  assert.equal(tracker.closes.length, 1);
});

test("runs the configured verification commands before opening a PR", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, git, agents, factory } = setup([target], {
    verification: { commands: ["npm ci", "npm test"] },
  });
  let pushesWhenVerified = -1;
  agents.onVerify = () => {
    pushesWhenVerified = git.pushes.length;
  };

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "pull-request");
  assert.deepEqual(agents.verifyCalls, [
    { branch: "softfac/42", commands: ["npm ci", "npm test"] },
  ]);
  assert.equal(pushesWhenVerified, 0);
  assert.match(
    tracker.pullRequests[0]!.body,
    /Verified by SoftFac: `npm ci`, `npm test`/,
  );
});

test("blocks the issue when a verification command fails", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, git, agents, factory } = setup([target], {
    verification: { commands: ["npm test"] },
  });
  agents.verifyResults = [
    {
      passed: false,
      results: [
        {
          command: "npm test",
          exitCode: 1,
          output: "1 failing\nAssertionError: expected 1 to equal 2",
        },
      ],
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.match(result.reason ?? "", /npm test/);
  assert.match(result.reason ?? "", /expected 1 to equal 2/);
  assert.equal(tracker.pullRequests.length, 0);
  assert.deepEqual(git.pushes, []);
  assert.equal(tracker.blocks.length, 1);
});

test("does not start verification when no commands are configured", async () => {
  const target = issue(42, ["feature"]);
  const { agents, factory } = setup([target]);

  await factory.processIssue(target);

  assert.equal(agents.verifyCalls.length, 0);
});

test("a substantial change gets an architecture review and waits for a human", async () => {
  const target = issue(42, ["feature"]);
  const { tracker, git, agents, state, factory } = setup([target], {
    architecture: { everyCommits: 10, requireForSubstantial: true },
  });

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "pull-request");
  assert.equal(result.architecture, "approved");
  assert.equal(tracker.pullRequests.length, 1);
  assert.match(tracker.pullRequests[0]!.body, /Part of #42/);
  assert.doesNotMatch(tracker.pullRequests[0]!.body, /Fixes #42/);
  assert.equal(tracker.merges.length, 0);
  assert.equal(tracker.closes.length, 0);
  assert.equal(
    tracker.labels.some((entry) => entry.labels.includes("arch:approved")),
    true,
  );
  assert.equal(
    tracker.labels.some((entry) => entry.labels.includes("softfac:needs-human")),
    true,
  );
  assert.equal(git.files.length, 1);
  assert.match(git.files[0]!.content, /Architecture is coherent\./);
  assert.equal(state.state.architecture.lastReviewedBaseSha, "base1234567890");
  assert.equal(state.state.architecture.decisions.length, 1);
  assert.equal(state.state.architecture.decisions[0]!.decision, "approved");
  assert.equal(
    state.state.architecture.decisions[0]!.summary,
    "Architecture is coherent.",
  );
  assert.deepEqual(agents.architectCalls[0]!.priorDecisions, []);
  assert.equal(state.state.issues["42"]!.status, "pull-request");
});

test("the architecture gate blocks the PR when it requests changes", async () => {
  const target = issue(42, ["docs"]);
  const { tracker, git, agents, state, factory } = setup([target], {
    architecture: { everyCommits: 2 },
  });
  git.commitsSince = 2;
  agents.architectResults = [
    {
      verdict: {
        decision: "changes_requested",
        summary: "Billing state now has two owners.",
        followUps: ["Extract a billing port"],
      },
      stdout: "",
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.architecture, "changes_requested");
  assert.match(result.reason ?? "", /two owners/);
  assert.equal(tracker.pullRequests.length, 0);
  assert.equal(tracker.blocks.length, 1);
  assert.equal(
    tracker.labels.some((entry) =>
      entry.labels.includes("arch:changes-requested"),
    ),
    true,
  );
  assert.equal(git.files.length, 1);
  assert.equal(state.state.architecture.lastReviewedBaseSha, "base1234567890");
});

test("review feedback is applied and re-reviewed using the same sessions", async () => {
  const target = issue(42, ["bug"]);
  const { agents, factory } = setup([target], {
    review: { maxRounds: 2 },
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  agents.implementResults = [
    { sessionId: "impl-1", commits: 1, stdout: "first" },
    { sessionId: "impl-2", commits: 1, stdout: "second" },
  ];
  agents.reviewResults = [
    {
      verdict: "changes_requested",
      summary: "Handle the empty input case.",
      findings: ["empty input"],
      sessionId: "rev-1",
      commits: 0,
    },
    {
      verdict: "approved",
      summary: "The empty input case is covered.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "done");
  assert.equal(result.reviewRounds, 2);
  assert.equal(agents.implementCalls.length, 2);
  assert.equal(agents.reviewCalls.length, 2);
  assert.equal(agents.implementCalls[1]!.sessionId, "impl-1");
  assert.equal(agents.implementCalls[1]!.feedback?.summary, "Handle the empty input case.");
  assert.equal(agents.reviewCalls[0]!.sessionId, undefined);
  assert.equal(agents.reviewCalls[1]!.sessionId, "rev-1");
});

test("blocks when review feedback produces no new commits", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, agents, factory } = setup([target], {
    review: { maxRounds: 2 },
  });
  agents.implementResults = [
    { sessionId: "impl-1", commits: 1, stdout: "first" },
    { sessionId: "impl-1", commits: 0, stdout: "nothing" },
  ];
  agents.reviewResults = [
    {
      verdict: "changes_requested",
      summary: "Handle the empty input case.",
      findings: ["empty input"],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.match(result.reason ?? "", /no commits/i);
  assert.equal(agents.reviewCalls.length, 1);
  assert.equal(tracker.pullRequests.length, 0);
});

test("continues when the branch already holds the work and the implementer adds nothing", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, git, agents, factory } = setup([target]);
  // The interrupted run committed the fix; this run has nothing left to add.
  git.commitsSince = 1;
  agents.implementResults = [
    { sessionId: "impl-1", commits: 0, stdout: "already committed" },
  ];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "The fix is on the branch.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "pull-request");
  assert.equal(tracker.blocks.length, 0);
  assert.equal(agents.reviewCalls.length, 1);
  assert.equal(
    git.countCalls.some(
      (call) => call.branch === "softfac/42" && call.sinceSha === "main",
    ),
    true,
  );
});

test("blocks when review still requests changes after the round limit", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, agents, factory } = setup([target], {
    review: { maxRounds: 1 },
  });
  agents.reviewResults = [
    {
      verdict: "changes_requested",
      summary: "Still wrong.",
      findings: ["missing guard"],
      sessionId: "rev-1",
      commits: 0,
    },
    {
      verdict: "changes_requested",
      summary: "Still wrong.",
      findings: ["missing guard"],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.reviewRounds, 2);
  assert.equal(tracker.pullRequests.length, 0);
  assert.equal(tracker.blocks.length, 1);
  assert.match(tracker.blocks[0]!.reason, /Review requested changes/i);
});

test("blocks when the implementer produces no commits", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, agents, factory } = setup([target]);
  agents.implementResults = [
    { sessionId: "impl-1", commits: 0, stdout: "nothing" },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.equal(agents.reviewCalls.length, 0);
  assert.equal(tracker.pullRequests.length, 0);
  assert.match(tracker.blocks[0]!.reason, /no commits/i);
});

test("runOnce respects the issue limit and keeps one reviewer session", async () => {
  const first = issue(42, ["bug"]);
  const second = issue(43, ["bug"]);
  const { agents, state, factory } = setup([first, second], {
    maxIssuesPerRun: 2,
  });
  agents.implementResults = [
    { sessionId: "impl-42", commits: 1, stdout: "" },
    { sessionId: "impl-43", commits: 1, stdout: "" },
  ];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "ok",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
    {
      verdict: "approved",
      summary: "ok",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const results = await factory.runOnce();

  assert.equal(results.length, 2);
  assert.equal(agents.implementCalls[0]!.sessionId, undefined);
  assert.equal(agents.implementCalls[1]!.sessionId, undefined);
  assert.equal(agents.reviewCalls[0]!.sessionId, undefined);
  assert.equal(agents.reviewCalls[1]!.sessionId, "rev-1");
  assert.equal(state.state.sessions["implementer:42"], "impl-42");
  assert.equal(state.state.sessions["implementer:43"], "impl-43");
  assert.equal(state.state.sessions["reviewer:bug"], "rev-1");
});

test("an agent failure blocks the issue and records it as failed", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, agents, state, factory } = setup([target]);
  agents.implementError = new Error("pi crashed");

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "failed");
  assert.equal(tracker.blocks.length, 1);
  assert.match(tracker.blocks[0]!.reason, /pi crashed/);
  assert.equal(state.state.issues["42"]!.status, "failed");
});

test("caps the architecture diff before prompting", async () => {
  const target = issue(42, ["feature"]);
  const { git, agents, factory } = setup([target], {
    architecture: {
      everyCommits: 10,
      requireForSubstantial: true,
      maxDiffChars: 100,
    },
  });
  git.diffText = "x".repeat(500);

  await factory.processIssue(target);

  const diff = agents.architectCalls[0]!.diff;
  assert.ok(diff.length < 500);
  assert.match(diff, /truncated the diff/i);
  assert.match(diff, /100 of 500 characters/i);
});

test("passes prior architecture decisions to the architect", async () => {
  const target = issue(42, ["feature"]);
  const { agents, state, factory } = setup([target], {
    architecture: { everyCommits: 10, requireForSubstantial: true },
  });
  const prior: ArchitectureDecisionRecord = {
    branch: "softfac/1",
    fromSha: null,
    toSha: "head-old",
    anchorSha: "base-old",
    decision: "approved",
    summary: "Keep billing behind a port.",
    followUps: ["Add an ADR"],
    reviewedAt: "2026-10-23T00:00:00.000Z",
  };
  state.state = {
    ...state.state,
    architecture: { lastReviewedBaseSha: null, decisions: [prior] },
  };

  await factory.processIssue(target);

  assert.deepEqual(agents.architectCalls[0]!.priorDecisions, [prior]);
});

test("falls back to branch commits when the review anchor is not an ancestor", async () => {
  const target = issue(42, ["docs"]);
  const { git, state, factory } = setup([target], {
    architecture: { everyCommits: 2 },
  });
  state.state = {
    ...state.state,
    architecture: { lastReviewedBaseSha: "old-anchor", decisions: [] },
  };
  git.ancestor = false;
  git.commitsSince = 2;

  await factory.processIssue(target);

  assert.deepEqual(git.countCalls[0], {
    branch: "softfac/42",
    sinceSha: null,
  });
});

test("a bug without test changes gets a TDD feedback round", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, git, agents, factory } = setup([target], {
    bugs: { autoMerge: true },
    verification: { commands: ["npm test"] },
  });
  git.changedPaths = ["src/fix.ts"];
  git.changedPathRounds = [
    ["src/fix.ts"],
    ["src/fix.ts", "tests/fix.test.ts"],
  ];
  agents.implementResults = [
    { sessionId: "impl-1", commits: 1, stdout: "first" },
    { sessionId: "impl-1", commits: 1, stdout: "second" },
  ];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "Looks fine.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
    {
      verdict: "approved",
      summary: "The regression is covered.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "done");
  assert.equal(result.reviewRounds, 2);
  assert.equal(agents.implementCalls.length, 2);
  assert.match(
    agents.implementCalls[1]!.feedback?.summary ?? "",
    /regression test/i,
  );
  assert.equal(tracker.pullRequests.length, 1);
  assert.match(tracker.pullRequests[0]!.body, /regression test/i);
});

test("blocks a bug that never adds a test", async () => {
  const target = issue(42, ["bug"]);
  const { tracker, git, agents, factory } = setup([target], {
    review: { maxRounds: 0 },
  });
  git.changedPaths = ["src/fix.ts"];
  agents.reviewResults = [
    {
      verdict: "approved",
      summary: "Looks fine.",
      findings: [],
      sessionId: "rev-1",
      commits: 0,
    },
  ];

  const result = await factory.processIssue(target);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.reviewRounds, 1);
  assert.match(result.reason ?? "", /regression test/i);
  assert.equal(agents.implementCalls.length, 1);
  assert.equal(tracker.pullRequests.length, 0);
  assert.equal(tracker.blocks.length, 1);
});

function seedWaiting(
  state: MemoryStateStore,
  patch: Partial<IssueRecord> = {},
): void {
  const base = state.state;
  state.state = {
    ...base,
    issues: {
      ...base.issues,
      "42": {
        number: 42,
        kind: "substantial",
        branch: "softfac/42",
        status: "pull-request",
        prNumber: 101,
        updatedAt: "2026-10-24T11:00:00Z",
        ...patch,
      },
    },
  };
}

test("addresses new human review feedback on a waiting PR", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.implementResults = [
    { sessionId: "impl-2", commits: 1, stdout: "addressed" },
  ];
  agents.reviewResults = [
    { verdict: "approved", summary: "Feedback addressed.", findings: [], commits: 0 },
  ];

  const results = await factory.runOnce();

  assert.equal(results.length, 1);
  assert.equal(results[0]!.outcome, "pull-request");
  assert.equal(results[0]!.prNumber, 101);
  assert.equal(results[0]!.reviewRounds, 1);
  assert.equal(agents.implementCalls[0]!.branch, "softfac/42");
  assert.match(
    agents.implementCalls[0]!.feedback!.findings[0]!,
    /kim: Please add a null check\./,
  );
  assert.deepEqual(git.pushes, ["softfac/42"]);
  assert.equal(tracker.claims.length, 0);
  assert.match(tracker.comments[0]!.body, /1 human review comment/);
  assert.equal(state.state.issues["42"]!.status, "pull-request");
  assert.deepEqual(state.state.issues["42"]!.addressedFeedback, [
    "comment:C_1",
  ]);
  assert.deepEqual(agents.released, ["softfac/42"]);
});

test("resumes an interrupted feedback round from the commits already on the branch", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  // The previous round committed and then blocked before the push.
  seedWaiting(state, {
    feedbackBase: "1111111111111111",
    feedbackPending: ["comment:C_1"],
  });
  git.head = "2222222222222222";
  agents.reviewResults = [
    { verdict: "approved", summary: "Feedback addressed.", findings: [], commits: 0 },
  ];

  const results = await factory.runOnce();

  assert.equal(agents.implementCalls.length, 0);
  assert.equal(agents.reviewCalls.length, 1);
  assert.equal(results[0]!.outcome, "pull-request");
  assert.deepEqual(git.pushes, ["softfac/42"]);
  assert.deepEqual(state.state.issues["42"]!.addressedFeedback, ["comment:C_1"]);
  assert.equal(state.state.issues["42"]!.feedbackBase, undefined);
  assert.equal(state.state.issues["42"]!.feedbackPending, undefined);
  // Resume is only safe while the branch still contains the round's base.
  assert.deepEqual(git.ancestorCalls[0], {
    ancestor: "1111111111111111",
    descendant: "softfac/42",
  });
});

test("implements a new comment when the branch has not moved since the last round", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_2",
        author: "kim",
        body: "Also cover the empty input.",
        createdAt: "2026-10-24T10:00:00Z",
      },
    ],
  });
  seedWaiting(state, {
    feedbackBase: git.head,
    feedbackPending: ["comment:C_1"],
  });

  await factory.runOnce();

  assert.equal(agents.implementCalls.length, 1);
  assert.equal(agents.reviewCalls.length, 1);
});

test("a failed feedback verification leaves a resumable round instead of repeating the comment", async () => {
  const { tracker, git, agents, state, factory } = setup([], {
    verification: { commands: ["npm test"] },
  });
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.implementResults = [
    { sessionId: "impl-2", commits: 1, stdout: "addressed" },
  ];
  agents.reviewResults = [
    { verdict: "approved", summary: "Feedback addressed.", findings: [], commits: 0 },
  ];
  agents.verifyResults = [
    {
      passed: false,
      results: [{ command: "npm test", exitCode: 1, output: "boom" }],
    },
  ];
  // The implementer's commit moves the branch while the gate runs.
  let moved = false;
  agents.onVerify = () => {
    if (!moved) {
      moved = true;
      git.head = "2222222222222222";
    }
  };

  const first = await factory.runOnce();

  assert.equal(first[0]!.outcome, "blocked");
  assert.deepEqual(git.pushes, []);
  assert.equal(state.state.issues["42"]!.feedbackBase, "abcdef1234567890");
  assert.deepEqual(state.state.issues["42"]!.feedbackPending, ["comment:C_1"]);
  assert.equal(state.state.issues["42"]!.addressedFeedback, undefined);

  // A requeue sends the issue back through the initial path, which finds the
  // commits already on the branch and pushes them.
  git.commitsSince = 1;
  agents.implementResults = [{ commits: 0, stdout: "already implemented" }];
  const requeued = await factory.processIssue(issue(42, ["feature"]));
  assert.equal(requeued.outcome, "pull-request");
  assert.deepEqual(git.pushes, ["softfac/42"]);

  // The comment is still fresh, but the round must resume rather than ask the
  // implementer to write the same change a second time.
  const second = await factory.runOnce();

  assert.equal(agents.implementCalls.length, 2);
  // The requeue ran the issue prompt; the comment was never handed over twice.
  assert.equal(agents.implementCalls[1]!.feedback, undefined);
  // The failed round, the requeue's own review, and the resumed round.
  assert.equal(agents.reviewCalls.length, 3);
  assert.deepEqual(git.pushes, ["softfac/42", "softfac/42"]);
  assert.deepEqual(state.state.issues["42"]!.addressedFeedback, ["comment:C_1"]);
  assert.equal(state.state.issues["42"]!.feedbackBase, undefined);
  assert.equal(state.state.issues["42"]!.feedbackPending, undefined);
});

test("holds a comment that arrives during a failed round for the next round", async () => {
  const { tracker, git, agents, state, factory } = setup([], {
    verification: { commands: ["npm test"] },
  });
  tracker.knownIssues.push(issue(42, ["feature"]));
  const first = {
    id: "comment:C_1",
    author: "kim",
    body: "Please add a null check.",
    createdAt: "2026-10-24T09:00:00Z",
  };
  tracker.discussions.set(101, { state: "OPEN", feedback: [first] });
  seedWaiting(state);
  agents.implementResults = [
    { sessionId: "impl-2", commits: 1, stdout: "addressed" },
  ];
  agents.reviewResults = [
    { verdict: "approved", summary: "Feedback addressed.", findings: [], commits: 0 },
  ];
  agents.verifyResults = [
    {
      passed: false,
      results: [{ command: "npm test", exitCode: 1, output: "boom" }],
    },
  ];
  let moved = false;
  agents.onVerify = () => {
    if (!moved) {
      moved = true;
      git.head = "2222222222222222";
    }
  };

  await factory.runOnce();
  assert.equal(state.state.issues["42"]!.status, "blocked");
  assert.deepEqual(state.state.issues["42"]!.feedbackPending, ["comment:C_1"]);

  // A second comment arrives before the first round has been verified.
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      first,
      {
        id: "comment:C_2",
        author: "kim",
        body: "Also cover the empty input.",
        createdAt: "2026-10-24T10:00:00Z",
      },
    ],
  });
  git.commitsSince = 1;
  agents.implementResults = [{ commits: 0, stdout: "already implemented" }];
  const requeued = await factory.processIssue(issue(42, ["feature"]));
  assert.equal(requeued.outcome, "pull-request");

  const resumed = await factory.runOnce();

  // The round still belongs to C_1 only; C_2 was never handed to anyone.
  assert.equal(resumed[0]!.outcome, "pull-request");
  assert.equal(agents.reviewCalls.length, 3);
  assert.deepEqual(state.state.issues["42"]!.addressedFeedback, ["comment:C_1"]);
  assert.equal(state.state.issues["42"]!.feedbackPending, undefined);

  const next = await factory.runOnce();

  // C_2 opens its own round on the next poll.
  assert.equal(next[0]!.outcome, "pull-request");
  assert.equal(agents.implementCalls.length, 3);
  assert.match(agents.implementCalls[2]!.feedback!.findings[0]!, /empty input/);
  assert.deepEqual(state.state.issues["42"]!.addressedFeedback, [
    "comment:C_1",
    "comment:C_2",
  ]);
});

test("blocks a resume when the branch no longer contains the round's base", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state, {
    feedbackBase: "1111111111111111",
    feedbackPending: ["comment:C_1"],
  });
  git.head = "2222222222222222";
  // The branch was reset to unrelated history instead of being extended.
  git.ancestor = false;

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "blocked");
  assert.match(tracker.blocks[0]!.reason, /no longer contains 1111111111111111/);
  assert.deepEqual(git.ancestorCalls[0], {
    ancestor: "1111111111111111",
    descendant: "softfac/42",
  });
  assert.equal(agents.implementCalls.length, 0);
  assert.equal(agents.reviewCalls.length, 0);
  assert.deepEqual(git.pushes, []);
});

test("re-runs the architecture gate after substantial human feedback before pushing", async () => {
  const { tracker, git, agents, state, factory } = setup([], {
    verification: { commands: ["npm test"] },
  });
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  let filesWhenVerified = -1;
  agents.onVerify = () => {
    filesWhenVerified = git.files.length;
  };

  const results = await factory.runOnce();

  assert.equal(results[0]!.architecture, "approved");
  assert.equal(agents.architectCalls.length, 1);
  assert.equal(git.files.length, 1);
  assert.equal(filesWhenVerified, 1);
  assert.deepEqual(git.pushes, ["softfac/42"]);
});

test("blocks substantial feedback when the architecture gate rejects the new commits", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "review:R_1",
        author: "sam",
        body: "Split this module.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.architectResults = [
    {
      verdict: {
        decision: "changes_requested",
        summary: "The change introduces two owners.",
        followUps: [],
      },
      stdout: "",
    },
  ];

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "blocked");
  assert.match(tracker.blocks[0]!.reason, /two owners/i);
  assert.deepEqual(git.pushes, []);
  assert.equal(state.state.issues["42"]!.addressedFeedback, undefined);
});

test("skips the architecture gate when feedback is not due", async () => {
  const { tracker, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["bug"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);

  const results = await factory.runOnce();

  assert.equal(results[0]!.architecture, "skipped");
  assert.equal(agents.architectCalls.length, 0);
});

test("does not repeat feedback that was already addressed", async () => {
  const { tracker, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state, { addressedFeedback: ["comment:C_1"] });

  const results = await factory.runOnce();

  assert.deepEqual(results, []);
  assert.equal(agents.implementCalls.length, 0);
});

test("skips a waiting issue whose PR is no longer open", async () => {
  const { tracker, agents, state, factory } = setup([]);
  tracker.discussions.set(101, {
    state: "MERGED",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "One more thing.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);

  const results = await factory.runOnce();

  assert.deepEqual(results, []);
  assert.equal(agents.implementCalls.length, 0);
  assert.equal(state.state.issues["42"]!.status, "pull-request");
});

test("blocks when the reviewer still requests changes after a feedback round", async () => {
  const { tracker, agents, state, factory } = setup([], {
    review: { maxRounds: 1 },
  });
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "review:R_1",
        author: "sam",
        body: "This is still wrong.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.implementResults = [
    { commits: 1, stdout: "first" },
    { commits: 1, stdout: "second" },
  ];
  agents.reviewResults = [
    { verdict: "changes_requested", summary: "Not yet.", findings: ["Still wrong."], commits: 0 },
    { verdict: "changes_requested", summary: "Not yet.", findings: ["Still wrong."], commits: 0 },
  ];

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "blocked");
  assert.match(tracker.blocks[0]!.reason, /still requests changes/i);
  assert.equal(state.state.issues["42"]!.status, "blocked");
  assert.equal(state.state.issues["42"]!.addressedFeedback, undefined);
});

test("blocks when feedback rewrites the branch history instead of appending", async () => {
  const { tracker, git, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please add a null check.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.implementResults = [
    { sessionId: "impl-2", commits: 1, stdout: "rebased" },
  ];
  agents.reviewResults = [
    { verdict: "approved", summary: "Feedback addressed.", findings: [], commits: 0 },
  ];
  // The implementer rebased away the architect's commit: the head handed to
  // it is no longer reachable from the branch.
  git.ancestor = false;

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "blocked");
  assert.match(tracker.blocks[0]!.reason, /rewrote the history/i);
  assert.deepEqual(git.ancestorCalls[0], {
    ancestor: "abcdef1234567890",
    descendant: "softfac/42",
  });
  assert.deepEqual(git.pushes, []);
  assert.equal(state.state.issues["42"]!.addressedFeedback, undefined);
  assert.equal(agents.architectCalls.length, 0);
});

test("blocks when the implementer produces no commits for human feedback", async () => {
  const { tracker, agents, state, factory } = setup([]);
  tracker.knownIssues.push(issue(42, ["feature"]));
  tracker.discussions.set(101, {
    state: "OPEN",
    feedback: [
      {
        id: "comment:C_1",
        author: "kim",
        body: "Please rename it.",
        createdAt: "2026-10-24T09:00:00Z",
      },
    ],
  });
  seedWaiting(state);
  agents.implementResults = [{ commits: 0, stdout: "" }];

  const results = await factory.runOnce();

  assert.equal(results[0]!.outcome, "blocked");
  assert.match(tracker.blocks[0]!.reason, /no commits/i);
  assert.equal(agents.reviewCalls.length, 0);
});
