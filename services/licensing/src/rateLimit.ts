export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly states = new Map<string, WindowState>();
  private operations = 0;

  constructor(
    private readonly config: {
      limit: number;
      windowMs: number;
      now?: () => number;
    },
  ) {
    if (
      !Number.isSafeInteger(config.limit) ||
      config.limit <= 0 ||
      !Number.isSafeInteger(config.windowMs) ||
      config.windowMs <= 0
    ) {
      throw new Error("Rate limit and window must be positive integers.");
    }
  }

  consume(key: string): RateLimitDecision {
    if (!key || key.length > 256) {
      throw new Error("Rate limiter key is invalid.");
    }
    const now = this.config.now?.() ?? Date.now();
    this.operations += 1;
    if (this.operations % 1_000 === 0) this.deleteExpired(now);

    const existing = this.states.get(key);
    const state =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.config.windowMs }
        : existing;
    if (state.count >= this.config.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, state.resetAt - now),
        resetAt: state.resetAt,
      };
    }
    state.count += 1;
    this.states.set(key, state);
    return {
      allowed: true,
      remaining: this.config.limit - state.count,
      retryAfterMs: 0,
      resetAt: state.resetAt,
    };
  }

  private deleteExpired(now: number): void {
    for (const [key, state] of this.states) {
      if (state.resetAt <= now) this.states.delete(key);
    }
  }
}
