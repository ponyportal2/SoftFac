export const MAX_POLL_DELAY_MS = 5 * 60_000;
export const MIN_POLL_DELAY_MS = 1_000;

export function nextPollDelay(
  consecutiveFailures: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(baseMs, MIN_POLL_DELAY_MS);
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 8);
  const ceiling = Math.min(base * 2 ** exponent, MAX_POLL_DELAY_MS);
  const jitter = ceiling * 0.2 * Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling + jitter);
}
