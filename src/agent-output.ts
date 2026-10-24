import { z } from "zod";

export interface ReviewVerdict {
  readonly verdict: "approved" | "changes_requested";
  readonly summary: string;
  readonly findings: string[];
}

const reviewSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"], {
    error: 'review verdict must be "approved" or "changes_requested"',
  }),
  summary: z
    .string({ error: "review summary must be a non-empty string" })
    .trim()
    .min(1, { error: "review summary must be a non-empty string" }),
  findings: z
    .array(z.string({ error: "review findings must be an array of strings" }), {
      error: "review findings must be an array of strings",
    })
    .default([]),
});

export function parseReviewOutput(stdout: string): ReviewVerdict {
  const match = /<review>([\s\S]*?)<\/review>/i.exec(stdout);
  if (!match?.[1]) {
    throw new Error("missing <review> block in reviewer output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (error) {
    throw new Error("invalid review JSON", { cause: error });
  }

  const result = reviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "invalid review");
  }
  return result.data;
}
