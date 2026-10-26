import assert from "node:assert/strict";
import { test } from "node:test";

import { promptArgsForIssue } from "../src/prompt-args.js";
import { issue } from "./support/fakes.js";

test("builds issue prompt arguments", () => {
  const args = promptArgsForIssue(
    issue(42, ["bug", "p1"]),
    "softfac/42",
    "main",
  );

  assert.deepEqual(args, {
    ISSUE_NUMBER: 42,
    ISSUE_TITLE: "Issue 42",
    ISSUE_BODY: "Body 42",
    ISSUE_URL: "https://example.test/issues/42",
    ISSUE_LABELS: "bug, p1",
    BRANCH: "softfac/42",
    BASE_BRANCH: "main",
  });
});
