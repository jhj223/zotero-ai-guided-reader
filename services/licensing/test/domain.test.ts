import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_PLANS,
  LicensingService,
  PaymentMismatchError,
} from "../src/domain.js";
import { LicensingStore } from "../src/database.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 6, 29, 12);

function setup() {
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const service = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => now,
    randomId: (prefix) => `${prefix}_${++sequence}`,
  });
  return { database, store, service };
}

test("starts a seven-day trial only once per device", () => {
  const { database, service } = setup();
  try {
    const first = service.startTrial("device-1");
    const repeated = service.startTrial("device-1");

    assert.deepEqual(first, repeated);
    assert.equal(first.planId, "trial");
    assert.equal(first.validUntil, now + 7 * DAY_MS);
  } finally {
    database.close();
  }
});

test("creates orders with server-owned monthly and yearly prices", () => {
  const { database, service } = setup();
  try {
    const monthly = service.createOrder("device-1", "pro_monthly");
    const yearly = service.createOrder("device-1", "pro_yearly");

    assert.equal(monthly.amountFen, 1990);
    assert.equal(monthly.durationDays, 30);
    assert.equal(yearly.amountFen, 19900);
    assert.equal(yearly.durationDays, 365);
    assert.notEqual(monthly.pollToken, yearly.pollToken);
  } finally {
    database.close();
  }
});

test("paid orders extend entitlement and duplicate callbacks are idempotent", () => {
  const { database, service } = setup();
  try {
    const firstOrder = service.createOrder("device-1", "pro_monthly");
    const first = service.recordPayment({
      orderId: firstOrder.id,
      transactionId: "wechat-tx-1",
      amountFen: firstOrder.amountFen,
      paidAt: now,
    });
    const duplicate = service.recordPayment({
      orderId: firstOrder.id,
      transactionId: "wechat-tx-1",
      amountFen: firstOrder.amountFen,
      paidAt: now,
    });
    assert.deepEqual(duplicate, first);
    assert.equal(first.validUntil, now + 30 * DAY_MS);

    const renewalOrder = service.createOrder("device-1", "pro_monthly");
    const renewed = service.recordPayment({
      orderId: renewalOrder.id,
      transactionId: "wechat-tx-2",
      amountFen: renewalOrder.amountFen,
      paidAt: now + 60 * 1000,
    });
    assert.equal(renewed.validUntil, now + 60 * DAY_MS);
  } finally {
    database.close();
  }
});

test("does not activate an order when the paid amount differs", () => {
  const { database, service } = setup();
  try {
    const order = service.createOrder("device-1", "pro_yearly");
    assert.throws(
      () =>
        service.recordPayment({
          orderId: order.id,
          transactionId: "wechat-tx-wrong",
          amountFen: order.amountFen - 1,
          paidAt: now,
        }),
      PaymentMismatchError,
    );
    assert.equal(
      service.getOrder(order.id, order.pollToken)?.status,
      "pending",
    );
  } finally {
    database.close();
  }
});

test("order polling requires the unguessable poll token", () => {
  const { database, service } = setup();
  try {
    const order = service.createOrder("device-1", "pro_monthly");
    assert.equal(service.getOrder(order.id, order.pollToken)?.id, order.id);
    assert.equal(service.getOrder(order.id, "wrong-token"), undefined);
  } finally {
    database.close();
  }
});

test("rejects payments completed after the order expired", () => {
  const { database, service } = setup();
  try {
    const order = service.createOrder("device-1", "pro_monthly");
    assert.throws(
      () =>
        service.recordPayment({
          orderId: order.id,
          transactionId: "wechat-tx-late",
          amountFen: order.amountFen,
          paidAt: order.expiresAt + 1,
        }),
      /expired/i,
    );
    assert.equal(
      service.getOrder(order.id, order.pollToken)?.status,
      "pending",
    );
  } finally {
    database.close();
  }
});

test("records webhook events and payment atomically with replay protection", () => {
  const { database, service } = setup();
  try {
    const order = service.createOrder("device-1", "pro_monthly");
    const input = {
      orderId: order.id,
      transactionId: "wechat-tx-webhook",
      amountFen: order.amountFen,
      paidAt: now,
    };

    const first = service.recordWebhookPayment("event-1", now, input);
    const replay = service.recordWebhookPayment("event-1", now + 1, input);

    assert.equal(first.isReplay, false);
    assert.equal(replay.isReplay, true);
    assert.deepEqual(replay.entitlement, first.entitlement);
  } finally {
    database.close();
  }
});

test("restarting trial never downgrades an existing Pro entitlement", () => {
  const { database, service } = setup();
  try {
    service.startTrial("device-1");
    const order = service.createOrder("device-1", "pro_yearly");
    const pro = service.recordPayment({
      orderId: order.id,
      transactionId: "wechat-tx-pro",
      amountFen: order.amountFen,
      paidAt: now,
    });

    assert.deepEqual(service.startTrial("device-1"), pro);
  } finally {
    database.close();
  }
});
