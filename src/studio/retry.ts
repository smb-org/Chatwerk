export function initialLoadRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
}
