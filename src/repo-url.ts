function cleanSlug(owner: string, repo: string): string | undefined {
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(cleanRepo)
  ) {
    return undefined;
  }
  return `${owner}/${cleanRepo}`;
}

export function parseRepoSlug(value: string): string | undefined {
  const trimmed = value.trim();

  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return cleanSlug(scp[1], scp[2]);
  }

  const ssh =
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) {
    return cleanSlug(ssh[1], ssh[2]);
  }

  const https =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (https?.[1] !== undefined && https[2] !== undefined) {
    return cleanSlug(https[1], https[2]);
  }

  const slug = /^([^/]+)\/([^/]+)$/.exec(trimmed);
  if (slug?.[1] !== undefined && slug[2] !== undefined) {
    return cleanSlug(slug[1], slug[2]);
  }

  return undefined;
}
