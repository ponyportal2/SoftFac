import type { Issue } from "./ports.js";
import type { PromptArgs } from "./prompts.js";

export function promptArgsForIssue(
  issue: Issue,
  branch: string,
  baseBranch: string,
): PromptArgs {
  return {
    ISSUE_NUMBER: issue.number,
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body,
    ISSUE_URL: issue.url,
    ISSUE_LABELS: issue.labels.join(", "),
    BRANCH: branch,
    BASE_BRANCH: baseBranch,
  };
}
