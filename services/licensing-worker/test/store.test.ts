import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LicensingService } from "../src/service";
import { LicensingStore } from "../src/store";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 11, 8);

function setup(now = NOW) {
  const store = new LicensingStore(env.DB);
  return {
    store,
    service: new LicensingService(store, () => now),
  };
}

describe("D1 licensing state", () => {
  it("starts a seven-day trial only once per device", async () => {
    const { service } = setup();
    const first = await service.startTrial("device_trial_001");
    const second = await service.startTrial("device_trial_001");

    expect(first).toEqual(second);
    expect(first.planId).toBe("trial");
    expect(first.validUntil).toBe(NOW + 7 * DAY_MS);
  });

  it("creates opaque orders and stores only a poll-token hash", async () => {
    const { service, store } = setup();
    const created = await service.createOrder(
      "device_order_001",
      "pro_monthly",
    );
    const stored = await store.findOrder(created.orderId);

    expect(created.orderId).toMatch(/^ord_[A-Za-z0-9_-]{20,}$/);
    expect(created.customOrderId).toMatch(/^co_[A-Za-z0-9_-]{20,}$/);
    expect(created.pollToken).toMatch(/^poll_[A-Za-z0-9_-]{20,}$/);
    expect(stored?.pollTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.pollTokenHash).not.toContain(created.pollToken);
    expect(await service.pollOrder(created.orderId, "wrong-token")).toBeUndefined();
    expect(await service.pollOrder(created.orderId, created.pollToken)).toEqual(
      stored,
    );
  });

  it("extends monthly and yearly plans from the later expiry", async () => {
    const { service } = setup();
    await service.startTrial("device_extend_001");
    const monthly = await service.createOrder(
      "device_extend_001",
      "pro_monthly",
    );
    const first = await service.completePayment({
      orderId: monthly.orderId,
      eventId: "event_monthly_001",
      providerTransactionId: "202608110001",
      amountFen: 590,
      paidAt: NOW,
      receivedAt: NOW + 1_000,
      verifiedAt: NOW + 2_000,
    });
    expect(first.entitlement.validUntil).toBe(NOW + 7 * DAY_MS + 30 * DAY_MS);

    const yearly = await service.createOrder(
      "device_extend_001",
      "pro_yearly",
    );
    const second = await service.completePayment({
      orderId: yearly.orderId,
      eventId: "event_yearly_001",
      providerTransactionId: "202608110002",
      amountFen: 4900,
      paidAt: NOW + DAY_MS,
      receivedAt: NOW + DAY_MS + 1_000,
      verifiedAt: NOW + DAY_MS + 2_000,
    });
    expect(second.entitlement.validUntil).toBe(
      NOW + 7 * DAY_MS + 30 * DAY_MS + 365 * DAY_MS,
    );
  });

  it("makes replayed and concurrent payment completion idempotent", async () => {
    const { service } = setup();
    const order = await service.createOrder(
      "device_replay_001",
      "pro_monthly",
    );
    const input = {
      orderId: order.orderId,
      eventId: "event_replay_001",
      providerTransactionId: "202608119999",
      amountFen: 590,
      paidAt: NOW,
      receivedAt: NOW + 1_000,
      verifiedAt: NOW + 2_000,
    } as const;

    const completed = await Promise.all([
      service.completePayment(input),
      service.completePayment(input),
    ]);
    expect(completed.filter((result) => result.isReplay)).toHaveLength(1);
    expect(completed[0].entitlement.validUntil).toBe(
      completed[1].entitlement.validUntil,
    );

    const replay = await service.completePayment(input);
    expect(replay.isReplay).toBe(true);
    expect(replay.entitlement.validUntil).toBe(NOW + 30 * DAY_MS);
  });

  it("does not return another device's entitlement", async () => {
    const { service } = setup();
    await service.startTrial("device_owner_001");
    expect(await service.getEntitlement("device_other_001")).toBeUndefined();
  });
});
