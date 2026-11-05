/** Thrown once SIGTERM or SIGINT cancels the run, so it writes nothing more to GitHub. */
export class RunCancelledError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`The run was cancelled by ${signal}`);
    this.name = 'RunCancelledError';
  }
}

let writeStop: AbortSignal | undefined;

/**
 * Stops the guarded GitHub writes once `signal` aborts, on top of any stop already in place.
 * Returns the combined signal and `release`, which lifts this stop again.
 */
export function stopWritesOn(signal: AbortSignal): { signal: AbortSignal; release: () => void } {
  const previous = writeStop;
  writeStop = previous ? AbortSignal.any([previous, signal]) : signal;
  return { signal: writeStop, release: () => { writeStop = previous; } };
}

/** Throws the abort reason once GitHub writes are stopped. Call it right before a review, dismissal, approval or thread write. */
export function assertWritesAllowed(): void {
  writeStop?.throwIfAborted();
}
