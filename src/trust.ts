/**
 * Feedback and approvals are only trusted when GitHub reports that the author
 * belongs to the repository. `MEMBER` means "member of the owning
 * organization", which is weaker than write access, so an explicit allowlist
 * covers people who review without a repository role.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "COLLABORATOR",
  "MEMBER",
]);

export interface TrustOptions {
  readonly trustedAuthors: readonly string[];
}

export function isTrustedAuthor(
  author: string,
  association: string | undefined,
  options: TrustOptions,
): boolean {
  const login = author.toLowerCase();
  if (
    options.trustedAuthors.some((entry) => entry.toLowerCase() === login)
  ) {
    return true;
  }
  return association !== undefined && TRUSTED_ASSOCIATIONS.has(association);
}
