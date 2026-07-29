import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter } from "../src/rateLimit.js";

test("limits each key independently and resets after the window", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 60_000,
    now: () => now,
  });

  assert.equal(limiter.consume("ip-a").allowed, true);
  assert.equal(limiter.consume("ip-a").allowed, true);
  const blocked = limiter.consume("ip-a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000);
  assert.equal(limiter.consume("ip-b").allowed, true);

  now += 60_001;
  assert.equal(limiter.consume("ip-a").allowed, true);
});

test("rejects empty or excessively long limiter keys", () => {
  const limiter = new FixedWindowRateLimiter({
    limit: 1,
    windowMs: 1_000,
  });
  assert.throws(() => limiter.consume(""), /key/i);
  assert.throws(() => limiter.consume("x".repeat(257)), /key/i);
});
