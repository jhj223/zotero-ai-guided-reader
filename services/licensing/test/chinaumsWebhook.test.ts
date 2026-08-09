import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { createChinaumsNotificationSignature } from "../src/payments/chinaumsAuth.js";
import { ChinaumsWebhookProcessor } from "../src/payments/chinaumsWebhook.js";

const now = Date.UTC(2026, 7, 10, 12, 35);
const billNo = "AB12202608102034567890000001";
const notificationKey = "independent-notification-key";

function setup(receivedAt = now + 1_000) {
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => now,
    randomId: (prefix) => `${prefix}_${++sequence}`,
  });
  const order = licensing.createOrder(
    "device-chinaums",
    "pro_monthly",
    "chinaums-qr",
  );
  licensing.bindProviderOrderId(order.id, billNo);
  const processor = new ChinaumsWebhookProcessor(
    {
      merchantId: "898201612345678",
      terminalId: "88880001",
      notificationKey,
    },
    licensing,
    { now: () => receivedAt },
  );
  return { database, licensing, order, processor };
}

function signedCallback(
  overrides: Readonly<Record<string, string>> = {},
  paymentOverrides: Readonly<Record<string, unknown>> = {},
  omittedFields: readonly string[] = [],
): string {
  const payment = JSON.stringify({
    billBizType: "bills",
    merOrderId: "provider-payment-1",
    paySeqId: "00684900520N",
    totalAmount: 1990,
    buyerPayAmount: 1990,
    payTime: "2026-08-10 20:35:00",
    status: "TRADE_SUCCESS",
    targetOrderId: "target-order-1",
    targetSys: "UnionPay",
    receiptAmount: 1990,
    ...paymentOverrides,
  });
  const fields = new Map<string, string>([
    ["billNo", billNo],
    ["billQRCode", "https://qr.chinaums.com/bills/qrCode.do?id=qr_123"],
    ["billDate", "2026-08-10"],
    ["billStatus", "PAID"],
    ["totalAmount", "1990"],
    ["notifyId", "notify_123"],
    ["seqId", "OUTERSEQ001"],
    ["nonce123", "random-value"],
    ["mid", "898201612345678"],
    ["tid", "88880001"],
    ["instMid", "QRPAYDEFAULT"],
    ["createTime", "2026-08-10 20:34:56"],
    ["billPayment", payment],
    ["signType", "SHA256"],
  ]);
  for (const [key, value] of Object.entries(overrides)) fields.set(key, value);
  for (const key of omittedFields) fields.delete(key);
  fields.set(
    "sign",
    createChinaumsNotificationSignature(fields, notificationKey),
  );
  return new URLSearchParams([...fields]).toString();
}

test("ChinaUMS webhook verifies a paid bill and replays idempotently", () => {
  const { database, licensing, order, processor } = setup();
  try {
    const rawBody = signedCallback();
    const first = processor.process(rawBody);
    const replay = processor.process(rawBody);

    assert.equal(first.isReplay, false);
    assert.equal(replay.isReplay, true);
    assert.deepEqual(replay.entitlement, first.entitlement);
    assert.equal(licensing.getOrder(order.id, order.pollToken)?.status, "paid");
    assert.equal(
      licensing.getOrder(order.id, order.pollToken)?.transactionId,
      "chinaums_00684900520N",
    );
    assert.equal(first.entitlement.validUntil, now + 30 * 24 * 60 * 60 * 1000);
  } finally {
    database.close();
  }
});

test("ChinaUMS webhook accepts a delayed callback for a payment made before expiry", () => {
  const { database, licensing, order, processor } = setup(
    now + 24 * 60 * 60 * 1000,
  );
  try {
    const result = processor.process(signedCallback());
    assert.equal(result.isReplay, false);
    assert.equal(licensing.getOrder(order.id, order.pollToken)?.status, "paid");
  } finally {
    database.close();
  }
});

test("ChinaUMS webhook accepts optional merchant echoes when the signature is valid", () => {
  const { database, licensing, order, processor } = setup();
  try {
    const result = processor.process(
      signedCallback({}, {}, ["mid", "tid", "instMid"]),
    );
    assert.equal(result.isReplay, false);
    assert.equal(licensing.getOrder(order.id, order.pollToken)?.status, "paid");
  } finally {
    database.close();
  }
});

test("ChinaUMS webhook rejects tampering, duplicate fields, and MD5", () => {
  const { database, processor } = setup();
  try {
    assert.throws(
      () =>
        processor.process(
          signedCallback().replace("totalAmount=1990", "totalAmount=1991"),
        ),
      /signature/i,
    );
    assert.throws(
      () => processor.process(`${signedCallback()}&mid=898201612345678`),
      /duplicate/i,
    );
    assert.throws(
      () => processor.process(signedCallback({ signType: "MD5" })),
      /SHA256/i,
    );
  } finally {
    database.close();
  }
});

test("ChinaUMS webhook fails closed on merchant, amount, and state mismatch", () => {
  const cases: ReadonlyArray<{ body: string; pattern: RegExp }> = [
    {
      body: signedCallback({ mid: "898201612345679" }),
      pattern: /merchant/i,
    },
    { body: signedCallback({ totalAmount: "1989" }), pattern: /amount/i },
    {
      body: signedCallback({ billStatus: "UNPAID" }),
      pattern: /paid/i,
    },
    {
      body: signedCallback({}, { status: "WAIT_BUYER_PAY" }),
      pattern: /successful/i,
    },
  ];

  for (const entry of cases) {
    const { database, processor } = setup();
    try {
      assert.throws(() => processor.process(entry.body), entry.pattern);
    } finally {
      database.close();
    }
  }
});
