import assert from "node:assert/strict";
import { test } from "node:test";

import { isTrustedAuthor } from "../src/trust.js";

const noAllowlist = { trustedAuthors: [] };

test("trusts owners, collaborators, and organization members", () => {
  for (const association of ["OWNER", "COLLABORATOR", "MEMBER"]) {
    assert.equal(isTrustedAuthor("alice", association, noAllowlist), true);
  }
});

test("does not trust outsiders or unknown associations", () => {
  assert.equal(isTrustedAuthor("mallory", "NONE", noAllowlist), false);
  assert.equal(isTrustedAuthor("mallory", "CONTRIBUTOR", noAllowlist), false);
  assert.equal(isTrustedAuthor("mallory", undefined, noAllowlist), false);
});

test("trusts an explicitly allowlisted author case-insensitively", () => {
  assert.equal(
    isTrustedAuthor("Alice", "NONE", { trustedAuthors: ["alice"] }),
    true,
  );
});
