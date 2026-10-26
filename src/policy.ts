export type IssueKind = "bug" | "substantial" | "normal";

export interface PolicyOptions {
  readonly bugLabels: readonly string[];
  readonly substantialLabels: readonly string[];
}

export interface PullRequestPolicyInput {
  readonly body: string;
  readonly labels: readonly string[];
  readonly issue: {
    readonly number: number;
    readonly labels: readonly string[];
  };
  readonly approvals: {
    readonly human: number;
    readonly architecture: boolean;
  };
  readonly policy: PolicyOptions;
}

export type ViolationCode =
  | "bug-missing-closing-reference"
  | "bug-missing-regression-test"
  | "substantial-must-not-auto-close"
  | "substantial-missing-architecture-approval"
  | "substantial-missing-human-approval"
  | "normal-must-not-auto-close"
  | "normal-missing-human-approval";

export interface PolicyViolation {
  readonly code: ViolationCode;
  readonly message: string;
}

export interface PolicyResult {
  readonly ok: boolean;
  readonly violations: PolicyViolation[];
}

function normalizeLabels(labels: readonly string[]): Set<string> {
  return new Set(labels.map((label) => label.trim().toLowerCase()));
}

export function classifyIssue(
  labels: readonly string[],
  options: PolicyOptions,
): IssueKind {
  const normalized = normalizeLabels(labels);
  const has = (candidates: readonly string[]) =>
    candidates.some((candidate) => normalized.has(candidate.toLowerCase()));

  if (has(options.bugLabels)) {
    return "bug";
  }
  if (has(options.substantialLabels)) {
    return "substantial";
  }
  return "normal";
}

export function closingReference(kind: IssueKind, issueNumber: number): string {
  return kind === "bug" ? `Fixes #${issueNumber}` : `Part of #${issueNumber}`;
}

function hasClosingReference(body: string, issueNumber: number): boolean {
  const pattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
    "i",
  );
  return pattern.test(body);
}

function hasRegressionTestDeclaration(body: string): boolean {
  return /-\s*\[[xX]\][^\n]*regression test/i.test(body);
}

function violation(code: ViolationCode, message: string): PolicyViolation {
  return { code, message };
}

export function validatePullRequest(
  input: PullRequestPolicyInput,
): PolicyResult {
  const kind = classifyIssue(input.issue.labels, input.policy);
  const closes = hasClosingReference(input.body, input.issue.number);
  const violations: PolicyViolation[] = [];

  if (kind === "bug") {
    if (!closes) {
      violations.push(
        violation(
          "bug-missing-closing-reference",
          `Bug PRs must include a closing reference such as "Fixes #${input.issue.number}".`,
        ),
      );
    }
    if (!hasRegressionTestDeclaration(input.body)) {
      violations.push(
        violation(
          "bug-missing-regression-test",
          'Bug PRs must check "- [x] Regression test added and failing before the fix."',
        ),
      );
    }
  }

  if (kind === "substantial") {
    if (closes) {
      violations.push(
        violation(
          "substantial-must-not-auto-close",
          `Substantial changes must reference the issue as "Part of #${input.issue.number}", not with a closing keyword.`,
        ),
      );
    }
    if (!input.approvals.architecture) {
      violations.push(
        violation(
          "substantial-missing-architecture-approval",
          "Substantial changes require the arch:approved label after an architecture review.",
        ),
      );
    }
    if (input.approvals.human < 1) {
      violations.push(
        violation(
          "substantial-missing-human-approval",
          "Substantial changes require at least one human approval.",
        ),
      );
    }
  }

  if (kind === "normal") {
    if (closes) {
      violations.push(
        violation(
          "normal-must-not-auto-close",
          `Normal changes must reference the issue as "Part of #${input.issue.number}", not with a closing keyword.`,
        ),
      );
    }
    if (input.approvals.human < 1) {
      violations.push(
        violation(
          "normal-missing-human-approval",
          "Normal changes require at least one human approval.",
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations };
}
