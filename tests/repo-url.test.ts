import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRepoSlug } from "../src/repo-url.js";

test("accepts an owner/repo slug", () => {
  assert.equal(parseRepoSlug("acme/widget"), "acme/widget");
});

test("parses an https GitHub remote", () => {
  assert.equal(
    parseRepoSlug("https://github.com/acme/widget.git"),
    "acme/widget",
  );
});

test("parses a scp-style GitHub remote", () => {
  assert.equal(parseRepoSlug("git@github.com:acme/widget.git"), "acme/widget");
});

test("parses an ssh GitHub remote", () => {
  assert.equal(
    parseRepoSlug("ssh://git@github.com/acme/widget.git"),
    "acme/widget",
  );
});

test("rejects unknown remotes", () => {
  assert.equal(parseRepoSlug("https://gitlab.com/acme/widget.git"), undefined);
  assert.equal(parseRepoSlug("not a repo"), undefined);
});
