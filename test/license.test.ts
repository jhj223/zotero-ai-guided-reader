import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_MS,
  entitlementState,
  extendEntitlement,
  formatRemainingDays,
  type EntitlementClaims,
} from "../src/core/license";

const now = Date.UTC(2026, 6, 29, 12);

function claims(overrides: Partial<EntitlementClaims> = {}): EntitlementClaims {
  return {
    version: 1,
    deviceId: "device-1",
    kind: "pro",
    planId: "pro_monthly",
    issuedAt: now - DAY_MS,
    offlineUntil: now + 20 * DAY_MS,
    validUntil: now + 29 * DAY_MS,
    ...overrides,
  };
}

test("recognizes active trial and pro entitlements", () => {
  assert.deepEqual(
    entitlementState(
      claims({
        kind: "trial",
        planId: "trial",
        validUntil: now + 3 * DAY_MS,
        offlineUntil: now + 3 * DAY_MS,
      }),
      "device-1",
      now,
    ),
    {
      status: "trial",
      canUsePro: true,
      validUntil: now + 3 * DAY_MS,
      remainingDays: 3,
    },
  );

  assert.deepEqual(entitlementState(claims(), "device-1", now), {
    status: "pro",
    canUsePro: true,
    validUntil: now + 29 * DAY_MS,
    remainingDays: 29,
  });
});

test("rejects wrong-device, expired, and stale-offline entitlements", () => {
  assert.equal(
    entitlementState(claims(), "other-device", now).status,
    "invalid",
  );
  assert.equal(
    entitlementState(
      claims({ validUntil: now - 1, offlineUntil: now - 1 }),
      "device-1",
      now,
    ).status,
    "expired",
  );
  assert.equal(
    entitlementState(claims({ offlineUntil: now - 1 }), "device-1", now).status,
    "refresh_required",
  );
});

test("extends paid time from the later of payment or current expiry", () => {
  assert.equal(extendEntitlement(undefined, 30, now), now + 30 * DAY_MS);
  assert.equal(
    extendEntitlement(now + 10 * DAY_MS, 30, now),
    now + 40 * DAY_MS,
  );
  assert.equal(extendEntitlement(now - DAY_MS, 365, now), now + 365 * DAY_MS);
});

test("formats customer-facing remaining days without showing zero", () => {
  assert.equal(formatRemainingDays(now + 1, now), "剩余 1 天");
  assert.equal(formatRemainingDays(now + 30 * DAY_MS, now), "剩余 30 天");
});
