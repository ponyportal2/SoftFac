export class WorktreeRegistry {
  readonly #paths = new Map<string, string>();

  set(branch: string, path: string): void {
    this.#paths.set(branch, path);
  }

  get(branch: string): string | undefined {
    return this.#paths.get(branch);
  }

  delete(branch: string): void {
    this.#paths.delete(branch);
  }

  branches(): string[] {
    return [...this.#paths.keys()];
  }
}
