import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createInitialState,
  FileStateStore,
  rememberArchitectureDecision,
  type FactoryState,
} from "../src/state.js";
import type { ArchitectureDecisionRecord } from "../src/architecture.js";

const cleanup: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "softfac-state-"));
  cleanup.push(dir);
  return dir;
}

function decision(
  overrides: Partial<ArchitectureDecisionRecord> = {},
): ArchitectureDecisionRecord {
  return {
    branch: "softfac/42",
    fromSha: null,
    toSha: "head1234567890",
    anchorSha: "base1234567890",
    decision: "approved",
    summary: "Boundaries hold.",
    followUps: [],
    reviewedAt: "2026-10-24T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("creates a versioned initial state", () => {
  const state = createInitialState(new Date("2026-10-24T00:00:00Z"));

  assert.deepEqual(state, {
    version: 2,
    architecture: {
      lastReviewedBaseSha: null,
      decisions: [],
    },
    sessions: {},
    issues: {},
    updatedAt: "2026-10-24T00:00:00.000Z",
  });
});

test("returns initial state when the file does not exist", async () => {
  const dir = await tempDir();
  const store = new FileStateStore(join(dir, "state.json"));

  const state = await store.read();

  assert.equal(state.version, 2);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.architecture.decisions, []);
});

test("writes and reads state", async () => {
  const dir = await tempDir();
  const path = join(dir, "nested", "state.json");
  const store = new FileStateStore(path);
  const state: FactoryState = {
    ...createInitialState(new Date("2026-10-24T00:00:00Z")),
    architecture: {
      lastReviewedBaseSha: "abc123",
      decisions: [decision()],
    },
    sessions: { reviewer: "session-1" },
  };

  await store.write(state);

  assert.deepEqual(await store.read(), state);
  const raw = JSON.parse(await readFile(path, "utf8")) as FactoryState;
  assert.equal(raw.architecture.lastReviewedBaseSha, "abc123");
  assert.equal(raw.architecture.decisions[0]!.summary, "Boundaries hold.");
});

test("migrates version 1 state and resets the review anchor", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      lastArchitectureReviewSha: "old-branch-head",
      sessions: { reviewer: "session-1" },
      issues: {},
      updatedAt: "2026-10-23T00:00:00.000Z",
    }),
    "utf8",
  );
  const store = new FileStateStore(path);

  const state = await store.read();

  assert.equal(state.version, 2);
  assert.deepEqual(state.architecture, {
    lastReviewedBaseSha: null,
    decisions: [],
  });
  assert.equal(state.sessions["reviewer"], "session-1");
  assert.equal(state.updatedAt, "2026-10-23T00:00:00.000Z");
});

test("rejects corrupt state instead of silently resetting", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await writeFile(path, "{not json", "utf8");
  const store = new FileStateStore(path);

  await assert.rejects(() => store.read(), /invalid softfac state/i);
});

test("rejects an unsupported state version", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 99,
      sessions: {},
      issues: {},
      updatedAt: "2026-10-24T00:00:00.000Z",
    }),
    "utf8",
  );
  const store = new FileStateStore(path);

  await assert.rejects(() => store.read(), /unsupported version/i);
});

test("rejects malformed architecture decisions", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      architecture: {
        lastReviewedBaseSha: null,
        decisions: [{ ...decision(), decision: "maybe" }],
      },
      sessions: {},
      issues: {},
      updatedAt: "2026-10-24T00:00:00.000Z",
    }),
    "utf8",
  );
  const store = new FileStateStore(path);

  await assert.rejects(() => store.read(), /architecture.*decision/i);
});

test("updates state through a mutator and persists it", async () => {
  const dir = await tempDir();
  const store = new FileStateStore(join(dir, "state.json"));

  const updated = await store.update((state) => ({
    ...state,
    architecture: {
      ...state.architecture,
      lastReviewedBaseSha: "deadbeef",
    },
  }));

  assert.equal(updated.architecture.lastReviewedBaseSha, "deadbeef");
  assert.equal(
    (await store.read()).architecture.lastReviewedBaseSha,
    "deadbeef",
  );
});

test("remembers decisions newest first and trims the history", () => {
  const state = createInitialState(new Date("2026-10-24T00:00:00Z"));
  const first = rememberArchitectureDecision(
    state,
    decision({ summary: "first" }),
    2,
  );
  const second = rememberArchitectureDecision(
    first,
    decision({ summary: "second", anchorSha: "base2" }),
    2,
  );
  const third = rememberArchitectureDecision(
    second,
    decision({ summary: "third", anchorSha: "base3" }),
    2,
  );

  assert.deepEqual(
    third.architecture.decisions.map((entry) => entry.summary),
    ["third", "second"],
  );
  assert.equal(third.architecture.lastReviewedBaseSha, "base3");
});
