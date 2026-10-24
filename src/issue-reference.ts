export function parseIssueReference(body: string): number | undefined {
  const match =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part\s+of)\s+#(\d+)\b/i.exec(
      body,
    );
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
