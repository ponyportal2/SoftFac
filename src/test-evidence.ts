function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegExp(char: string): string {
  return "\\^$.*+?()[]{}|".includes(char) ? `\\${char}` : char;
}

function patternToRegExp(pattern: string): RegExp {
  let normalized = normalizePath(pattern.trim());
  if (normalized.endsWith("/")) {
    normalized = `${normalized}**`;
  }

  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

export function matchesTestPattern(file: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(normalizePath(file));
}

export function hasTestEvidence(
  files: readonly string[],
  patterns: readonly string[],
): boolean {
  return files.some((file) =>
    patterns.some((pattern) => matchesTestPattern(file, pattern)),
  );
}
