import type { IssueKind } from "./policy.js";
import { closingReference } from "./policy.js";
import type { Issue } from "./ports.js";

export interface PullRequestBodyInput {
  readonly kind: IssueKind;
  readonly issue: Issue;
  readonly branch: string;
  readonly reviewSummary: string;
  readonly architectureSummary?: string;
  readonly findings?: readonly string[];
  readonly verification?: readonly string[];
}

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const sections: string[] = [
    "## Summary",
    input.reviewSummary,
    "",
    closingReference(input.kind, input.issue.number),
    "",
    "## Verification",
  ];

  const commands = input.verification ?? [];
  const verificationLine =
    commands.length > 0
      ? `- [x] Verified by SoftFac: ${commands
          .map((command) => `\`${command}\``)
          .join(", ")}.`
      : "- [ ] SoftFac did not run tests: no verification commands are configured.";

  if (input.kind === "bug") {
    sections.push(
      "- [x] Regression test added and failing before the fix.",
      verificationLine,
    );
  } else {
    sections.push(verificationLine, "- [x] Reviewer approved the change.");
  }

  if (input.architectureSummary !== undefined) {
    sections.push("", "## Architecture review", input.architectureSummary);
  }

  if (input.findings !== undefined && input.findings.length > 0) {
    sections.push("", "## Review findings");
    for (const finding of input.findings) {
      sections.push(`- ${finding}`);
    }
  }

  sections.push("", "## Branch", `\`${input.branch}\``);

  return sections.join("\n");
}
