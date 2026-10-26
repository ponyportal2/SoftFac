import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildArchitectureContext,
  readableDocumentPaths,
} from "../src/architecture-context.js";

const files = [
  "src/factory.ts",
  "src/git.ts",
  "tests/factory.test.ts",
  "docs/architecture/reviews/2026-10-24-abcdef1.md",
  "docs/adr/0001-ports.md",
  "package.json",
  "package-lock.json",
  "coverage/coverage-summary.json",
  "README.md",
];

test("summarizes the repository for the architect", () => {
  const text = buildArchitectureContext({
    files,
    changedFiles: ["src/factory.ts", "tests/factory.test.ts"],
  });

  assert.match(text, /Changed files \(2\):/);
  assert.match(text, /- src\/factory\.ts/);
  assert.match(text, /Module inventory:/);
  assert.match(text, /- src: 2 files/);
  assert.match(text, /- tests: 1 file/);
  assert.match(text, /Architecture documents:/);
  assert.match(text, /docs\/adr\/0001-ports\.md/);
  assert.match(text, /Dependency manifests:[\s\S]*- package\.json/);
  assert.match(
    text,
    /Test coverage data:[\s\S]*- coverage\/coverage-summary\.json/,
  );
});

test("reports absent context explicitly", () => {
  const text = buildArchitectureContext({
    files: ["src/a.ts"],
    changedFiles: [],
  });

  assert.match(text, /Changed files: none/);
  assert.match(text, /Architecture documents: none tracked/);
  assert.match(text, /Dependency manifests: none tracked/);
  assert.match(text, /Test coverage data: none tracked/);
});

test("includes the contents of decision documents", () => {
  const text = buildArchitectureContext({
    files,
    changedFiles: [],
    documents: [
      { path: "docs/adr/0001-ports.md", content: "Adapters own all I/O." },
    ],
  });

  assert.match(text, /Document contents:/);
  assert.match(text, /### docs\/adr\/0001-ports\.md/);
  assert.match(text, /Adapters own all I\/O\./);
});

test("caps the space spent on document contents", () => {
  const text = buildArchitectureContext({
    files: [],
    changedFiles: [],
    documents: [
      { path: "docs/adr/0001-ports.md", content: "x".repeat(5000) },
    ],
  });

  assert.match(text, /truncated/);
  assert.equal(text.includes("x".repeat(4001)), false);
  assert.ok(text.length < 5000);
});

test("reads the newest decision documents and skips review notes", () => {
  const paths = readableDocumentPaths([
    "docs/architecture/reviews/2026-10-24-abcdef1.md",
    "docs/adr/0001-ports.md",
    "docs/adr/0007-parser.md",
    "adr/0002-events.md",
    "docs/decisions/0003-cache.md",
    "docs/adr/overview.md",
    "docs/adr/0004-jobs.md",
    "docs/adr/0005-auth.md",
  ]);

  assert.deepEqual(paths, [
    "docs/adr/0007-parser.md",
    "docs/adr/0005-auth.md",
    "docs/adr/0004-jobs.md",
    "docs/decisions/0003-cache.md",
    "adr/0002-events.md",
  ]);
});

test("caps a long changed-file list", () => {
  const changed = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`);
  const text = buildArchitectureContext({ files: changed, changedFiles: changed });

  assert.match(text, /\+10 more/);
  assert.equal(text.includes("src/f59.ts"), false);
  assert.equal(text.includes("src/f49.ts"), true);
});
