import { z } from "zod";

export type ArchitectureDecision = "approved" | "changes_requested";

export interface ArchitectureVerdict {
  readonly decision: ArchitectureDecision;
  readonly summary: string;
  readonly followUps: string[];
}

export interface ArchitectureDecisionRecord {
  readonly branch: string;
  readonly fromSha: string | null;
  readonly toSha: string;
  readonly anchorSha: string;
  readonly decision: ArchitectureDecision;
  readonly summary: string;
  readonly followUps: readonly string[];
  readonly reviewedAt: string;
}

export function shouldRunArchitectureReview(input: {
  readonly commitsSinceReview: number;
  readonly interval: number;
}): boolean {
  if (input.interval <= 0) {
    return false;
  }
  return input.commitsSinceReview >= input.interval;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function architectureReviewPath(input: {
  readonly date: Date;
  readonly sha: string;
}): string {
  return `docs/architecture/reviews/${isoDate(input.date)}-${input.sha.slice(0, 7)}.md`;
}

export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) {
    return diff;
  }

  const omitted = diff.length - maxChars;
  return (
    `${diff.slice(0, maxChars)}\n\n` +
    `[SoftFac truncated the diff: showing the first ${maxChars} of ` +
    `${diff.length} characters (${omitted} omitted).]`
  );
}

const architectureSchema = z.object({
  decision: z.enum(["approved", "changes_requested"], {
    error: 'architecture decision must be "approved" or "changes_requested"',
  }),
  summary: z
    .string({ error: "architecture summary must be a non-empty string" })
    .trim()
    .min(1, { error: "architecture summary must be a non-empty string" }),
  followUps: z
    .array(
      z.string({ error: "architecture followUps must be an array of strings" }),
      { error: "architecture followUps must be an array of strings" },
    )
    .default([]),
});

export function parseArchitectureVerdict(stdout: string): ArchitectureVerdict {
  const match = /<architecture>([\s\S]*?)<\/architecture>/i.exec(stdout);
  if (!match?.[1]) {
    throw new Error("missing <architecture> block in architect output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (error) {
    throw new Error("invalid architecture JSON", { cause: error });
  }

  const result = architectureSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "invalid architecture");
  }
  return result.data;
}

export function decisionLabel(decision: ArchitectureDecision): string {
  return decision === "approved" ? "arch:approved" : "arch:changes-requested";
}

function normalizeFollowUp(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function newFollowUps(
  followUps: readonly string[],
  priorDecisions: readonly ArchitectureDecisionRecord[],
): string[] {
  const seen = new Set<string>();
  for (const decision of priorDecisions) {
    for (const followUp of decision.followUps) {
      seen.add(normalizeFollowUp(followUp));
    }
  }

  const fresh: string[] = [];
  for (const followUp of followUps) {
    const key = normalizeFollowUp(followUp);
    if (key === "" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    fresh.push(followUp.trim());
  }
  return fresh;
}

export function formatArchitectureHistory(
  decisions: readonly ArchitectureDecisionRecord[],
): string {
  if (decisions.length === 0) {
    return "None. This is the first architecture review.";
  }

  return decisions
    .map((decision) => {
      const followUps =
        decision.followUps.length === 0
          ? ""
          : ` Follow-ups: ${decision.followUps.join("; ")}.`;
      const from =
        decision.fromSha === null ? "initial" : decision.fromSha.slice(0, 7);
      const range = `${from}..${decision.toSha.slice(0, 7)}`;
      return `- ${decision.reviewedAt.slice(0, 10)} ${decision.decision} on ${decision.branch} (${range}): ${decision.summary}${followUps}`;
    })
    .join("\n");
}
