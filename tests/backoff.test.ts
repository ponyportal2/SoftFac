import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_POLL_DELAY_MS, nextPollDelay } from "../src/backoff.js";

test("uses the poll interval after a successful cycle", () => {
  assert.equal(nextPollDelay(0, 60_000, () => 0), 60_000);
});

test("backs off exponentially after consecutive failures", () => {
  assert.equal(nextPollDelay(1, 1_000, () => 0), 2_000);
  assert.equal(nextPollDelay(3, 1_000, () => 0), 8_000);
});

test("adds up to twenty percent jitter", () => {
  assert.equal(nextPollDelay(0, 1_000, () => 1), 1_200);
});

test("caps the delay", () => {
  assert.equal(nextPollDelay(20, 60_000, () => 0), MAX_POLL_DELAY_MS);
});

test("never polls faster than once a second", () => {
  assert.equal(nextPollDelay(0, 0, () => 0), 1_000);
});
