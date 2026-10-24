export interface ArchitectureDocument {
  readonly path: string;
  readonly content: string;
}

export interface ArchitectureContextInput {
  readonly files: readonly string[];
  readonly changedFiles: readonly string[];
  readonly documents?: readonly ArchitectureDocument[];
}

const CHANGED_LIMIT = 50;
const DOCUMENT_LIMIT = 20;
const DOCUMENT_CONTENT_LIMIT = 5;
const DOCUMENT_CONTENT_CHARS = 4000;

const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "Pipfile",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const COVERAGE_NAMES: ReadonlySet<string> = new Set([
  "coverage-summary.json",
  "coverage.json",
  "coverage.xml",
  "lcov.info",
  "cobertura.xml",
  "jacoco.xml",
]);

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function normalize(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path !== ""))];
}

function isArchitectureDocument(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".md")) {
    return false;
  }
  return (
    lower.startsWith("docs/architecture/") ||
    lower.startsWith("adr/") ||
    lower.includes("/adr/") ||
    lower.includes("/decisions/")
  );
}

function isDecisionDocument(path: string): boolean {
  return (
    isArchitectureDocument(path) &&
    !path.toLowerCase().split("/").includes("reviews")
  );
}

function documentOrder(path: string): number {
  const match = /(\d+)/.exec(basename(path));
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * The decision documents worth reading: numbered ADRs first, newest first,
 * without the architect's own review notes (they are already in the prompt
 * as prior decisions).
 */
export function readableDocumentPaths(files: readonly string[]): string[] {
  return normalize(files)
    .filter(isDecisionDocument)
    .sort(
      (left, right) =>
        documentOrder(right) - documentOrder(left) ||
        right.localeCompare(left),
    )
    .slice(0, DOCUMENT_CONTENT_LIMIT);
}

function documentSection(
  documents: readonly ArchitectureDocument[],
): string | undefined {
  if (documents.length === 0) {
    return undefined;
  }

  const blocks = documents.map((document) => {
    const content = document.content.trim();
    const body =
      content.length > DOCUMENT_CONTENT_CHARS
        ? `${content.slice(0, DOCUMENT_CONTENT_CHARS)}\n… (truncated)`
        : content;
    return `### ${document.path}\n${body}`;
  });
  return ["Document contents:", ...blocks].join("\n\n");
}

function changedSection(changed: readonly string[]): string {
  if (changed.length === 0) {
    return "Changed files: none";
  }

  const shown = changed.slice(0, CHANGED_LIMIT);
  const lines = [
    `Changed files (${changed.length}):`,
    ...shown.map((path) => `- ${path}`),
  ];
  if (changed.length > shown.length) {
    lines.push(`- (+${changed.length - shown.length} more)`);
  }
  return lines.join("\n");
}

function moduleInventory(files: readonly string[]): string {
  if (files.length === 0) {
    return "Module inventory: none tracked";
  }

  const counts = new Map<string, number>();
  for (const file of files) {
    const [head, ...rest] = file.split("/");
    const module = rest.length === 0 ? "(root)" : (head ?? "(root)");
    counts.set(module, (counts.get(module) ?? 0) + 1);
  }

  const lines = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, count]) =>
        `- ${name}: ${count} file${count === 1 ? "" : "s"}`,
    );
  return ["Module inventory:", ...lines].join("\n");
}

function listSection(
  title: string,
  entries: readonly string[],
  limit: number,
): string {
  if (entries.length === 0) {
    return `${title}: none tracked`;
  }

  const sorted = [...entries].sort((left, right) => left.localeCompare(right));
  const shown = sorted.slice(0, limit);
  const lines = [`${title}:`, ...shown.map((entry) => `- ${entry}`)];
  if (sorted.length > shown.length) {
    lines.push(`- (+${sorted.length - shown.length} more)`);
  }
  return lines.join("\n");
}

export function buildArchitectureContext(
  input: ArchitectureContextInput,
): string {
  const files = normalize(input.files);
  const changed = normalize(input.changedFiles);

  const sections = [
    changedSection(changed),
    moduleInventory(files),
    listSection(
      "Architecture documents",
      files.filter(isArchitectureDocument),
      DOCUMENT_LIMIT,
    ),
    listSection(
      "Dependency manifests",
      files.filter((path) => MANIFEST_NAMES.has(basename(path))),
      DOCUMENT_LIMIT,
    ),
    listSection(
      "Test coverage data",
      files.filter((path) => COVERAGE_NAMES.has(basename(path))),
      DOCUMENT_LIMIT,
    ),
  ];

  const documents = documentSection(input.documents ?? []);
  if (documents !== undefined) {
    sections.push(documents);
  }
  return sections.join("\n\n");
}
