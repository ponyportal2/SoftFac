/**
 * Feedback may come from anyone affiliated with the project. `MEMBER` means
 * "member of the owning organization", which is weaker than write access, so
 * it is a pragmatic bar for spending an agent round, not proof that the
 * author can merge. An explicit allowlist covers people without a role.
 */
const FEEDBACK_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "COLLABORATOR",
  "MEMBER",
]);

export interface TrustOptions {
  readonly trustedAuthors: readonly string[];
}

function isAllowlisted(author: string, options: TrustOptions): boolean {
  const login = author.toLowerCase();
  return options.trustedAuthors.some(
    (entry) => entry.toLowerCase() === login,
  );
}

export function isTrustedAuthor(
  author: string,
  association: string | undefined,
  options: TrustOptions,
): boolean {
  if (isAllowlisted(author, options)) {
    return true;
  }
  return association !== undefined && FEEDBACK_ASSOCIATIONS.has(association);
}
