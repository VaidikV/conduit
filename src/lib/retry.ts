// ---------------------------------------------------------------------------
// Retry policy: which failures are worth another try, and how long to wait.
//
// Two ideas do all the work:
//
// 1. Not all failures are the same. A 500 or a dropped connection is the
//    server having a bad moment; trying again later is sensible. A 400 is
//    the request itself being wrong; retrying the identical request is
//    pointless. A 429 is the server explicitly asking us to slow down.
//
// 2. Backoff. When the server is struggling, the kindest thing is to get out
//    of its way fast, so the waits grow: 1s, 2s, 4s, ... A little random
//    jitter keeps many clients from retrying in lockstep and slamming the
//    server together (a thundering herd).
// ---------------------------------------------------------------------------

/** Total tries of a step, including the first attempt. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Hard ceiling on per-step attempts, so one step can't wedge a worker. */
export const MAX_ALLOWED_ATTEMPTS = 10;
/** First backoff wait; each failed attempt doubles it from here. */
export const BACKOFF_BASE_MS = 1_000;
/** Backoff never waits longer than this between two attempts. */
export const BACKOFF_CAP_MS = 30_000;
/** Random jitter added to every wait, to spread retries out. */
export const JITTER_MAX_MS = 1_000;
/** A Retry-After header is honored, but never beyond this. */
export const RETRY_AFTER_CAP_MS = 60_000;

// Worth retrying: the server is struggling (5xx), asked us to slow down
// (429), or never answered in time (408). Every other 4xx is the request's
// own fault.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A failed HTTP step. Carries the status when there was one; a missing
 * status means the request never completed (network error, DNS failure,
 * timeout), which is always retryable.
 */
export class StepHttpError extends Error {
  readonly status?: number;
  readonly headers: Record<string, string>;

  constructor(
    message: string,
    opts: { status?: number; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'StepHttpError';
    this.status = opts.status;
    this.headers = opts.headers ?? {};
  }
}

/** True when trying the same step again could plausibly succeed. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof StepHttpError) {
    if (err.status === undefined) return true; // never got a response
    return RETRYABLE_STATUSES.has(err.status);
  }
  // Anything else (bad config, programmer error) will fail identically.
  return false;
}

/**
 * Exponential backoff for the n-th failed attempt (1-based): 1s, 2s, 4s,
 * ... capped at 30s, plus up to 1s of random jitter.
 */
export function backoffDelayMs(failedAttempt: number): number {
  const grown = BACKOFF_BASE_MS * 2 ** (failedAttempt - 1);
  const capped = Math.min(BACKOFF_CAP_MS, grown);
  return capped + Math.random() * JITTER_MAX_MS;
}

/**
 * Parse a Retry-After header value into milliseconds. Handles both forms:
 * delta-seconds ("120") and an HTTP date. Returns undefined when the value
 * is missing or unparseable.
 */
export function parseRetryAfter(
  headers: Record<string, string>,
): number | undefined {
  const raw = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'retry-after',
  )?.[1];
  if (!raw) return undefined;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }
  const when = Date.parse(value);
  if (!Number.isNaN(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

/**
 * How long to wait after the n-th failed attempt. Honors Retry-After on a
 * 429 (the server telling us exactly how long to back off), capped so one
 * header can't wedge a worker; everything else uses exponential backoff.
 */
export function retryDelayMs(err: unknown, failedAttempt: number): number {
  const backoff = backoffDelayMs(failedAttempt);
  if (err instanceof StepHttpError && err.status === 429) {
    const asked = parseRetryAfter(err.headers);
    if (asked !== undefined) {
      return Math.max(backoff, Math.min(asked, RETRY_AFTER_CAP_MS));
    }
  }
  return backoff;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
