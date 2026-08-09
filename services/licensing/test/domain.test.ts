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

function setup(clock: () => number = () => now, plans = DEFAULT_PLANS) {
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const service = new LicensingService({
    store,
    plans,
    now: clock,
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
    assert.equal(monthly.provider, "sandbox");
    assert.equal(yearly.provider, "sandbox");
    assert.notEqual(monthly.pollToken, yearly.pollToken);
  } finally {
    database.close();
  }
});

test("reserves all one hundred unique static QR cent suffixes", () => {
  const { database, service } = setup();
  try {
    const orders = Array.from({ length: 100 }, (_, index) =>
      service.createOrder(
        `device-static-${index}`,
        "pro_monthly",
        "wechat-static-qr",
      ),
    );

    assert.deepEqual(
      orders.map((order) => order.amountFen),
      Array.from({ length: 100 }, (_, suffix) => 1990 + suffix),
    );
    assert.ok(
      orders.every(
        (order) =>
          order.amountReservedUntil === now + 48 * 60 * 60 * 1000 &&
          order.baseAmountFen === 1990 &&
          order.provider === "wechat-static-qr",
      ),
    );
    assert.throws(
      () =>
        service.createOrder(
          "device-static-overflow",
          "pro_monthly",
          "wechat-static-qr",
        ),
      /PAYMENT_SLOTS_BUSY/,
    );
  } finally {
    database.close();
  }
});

test("reuses a static QR amount only after its reservation expires", () => {
  let currentTime = now;
  const { database, service } = setup(() => currentTime);
  try {
    const first = service.createOrder(
      "device-static-first",
      "pro_monthly",
      "wechat-static-qr",
    );
    currentTime += 48 * 60 * 60 * 1000 + 1;
    const reused = service.createOrder(
      "device-static-reused",
      "pro_monthly",
      "wechat-static-qr",
    );

    assert.equal(first.amountFen, 1990);
    assert.equal(reused.amountFen, 1990);
  } finally {
    database.close();
  }
});

test("keeps static QR amounts unique across overlapping plan price ranges", () => {
  const plans = [
    { ...DEFAULT_PLANS[0], priceFen: 1990 },
    { ...DEFAULT_PLANS[1], priceFen: 1995 },
  ] as const;
  const { database, service } = setup(() => now, plans);
  try {
    const monthly = Array.from({ length: 6 }, (_, index) =>
      service.createOrder(
        `device-overlap-monthly-${index}`,
        "pro_monthly",
        "wechat-static-qr",
      ),
    );
    const yearly = service.createOrder(
      "device-overlap-yearly",
      "pro_yearly",
      "wechat-static-qr",
    );

    assert.deepEqual(
      monthly.map((order) => order.amountFen),
      [1990, 1991, 1992, 1993, 1994, 1995],
    );
    assert.equal(yearly.amountFen, 1996);
  } finally {
    database.close();
  }
});

test("keeps catalog prices unchanged for non-static providers", () => {
  const { database, service } = setup();
  try {
    const sandbox = service.createOrder(
      "device-sandbox",
      "pro_monthly",
      "sandbox",
    );
    const native = service.createOrder(
      "device-native",
      "pro_yearly",
      "wechat-native",
    );

    assert.equal(sandbox.amountFen, 1990);
    assert.equal(native.amountFen, 19900);
    assert.equal(sandbox.baseAmountFen, sandbox.amountFen);
    assert.equal(native.baseAmountFen, native.amountFen);
  } finally {
    database.close();
  }
});

test("binds one unique ChinaUMS bill number to one local order", () => {
  const { database, service } = setup();
  try {
    const order = service.createOrder(
      "device-chinaums-one",
      "pro_monthly",
      "chinaums-qr",
    );
    const second = service.createOrder(
      "device-chinaums-two",
      "pro_monthly",
      "chinaums-qr",
    );
    const billNo = "AB12202608102034567890000001";

    assert.equal(service.bindProviderOrderId(order.id, billNo), billNo);
    assert.equal(service.bindProviderOrderId(order.id, billNo), billNo);
    assert.equal(service.findOrderByProviderOrderId(billNo)?.id, order.id);
    assert.throws(
      () => service.bindProviderOrderId(order.id, `${billNo}9`),
      /already bound/i,
    );
    assert.throws(
      () => service.bindProviderOrderId(second.id, billNo),
      /already bound/i,
    );
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
