import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyLike,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { StaticQrBridge } from "../src/payments/staticQrBridge.js";

const START_TIME = Date.UTC(2026, 6, 30, 12);
const RECEIPT_PATH = "/v1/merchant/receipts";
const HEARTBEAT_PATH = "/v1/merchant/heartbeat";

function setup() {
  let currentTime = START_TIME;
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => currentTime,
    randomId: (prefix) => `${prefix}_bridge_${++sequence}`,
  });
  const keys = generateKeyPairSync("ed25519");
  const bridge = new StaticQrBridge(
    {
      store,
      licensing,
      watcherPublicKeys: new Map([["merchant-pc-01", keys.publicKey]]),
    },
    { now: () => currentTime },
  );
  return {
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
    bridge,
    database,
    keys,
    licensing,
  };
}

function signedHeaders(input: {
  body: string;
  keyId?: string;
  nonce?: string;
  path: string;
  privateKey: KeyLike;
  timestamp?: number;
}): Headers {
  const keyId = input.keyId || "merchant-pc-01";
  const nonce = input.nonce || "nonce_1234567890abcdef";
  const timestamp = input.timestamp ?? Math.floor(START_TIME / 1000);
  const digest = createHash("sha256")
    .update(input.body, "utf8")
    .digest("base64url");
  const message = [
    "POST",
    input.path,
    String(timestamp),
    nonce,
    digest,
    "",
  ].join("\n");
  return new Headers({
    "X-Receipt-Key-Id": keyId,
    "X-Receipt-Timestamp": String(timestamp),
    "X-Receipt-Nonce": nonce,
    "X-Receipt-Signature": sign(
      null,
      Buffer.from(message, "utf8"),
      input.privateKey,
    ).toString("base64url"),
  });
}

function heartbeatBody(
  replacements: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    schema: "wechat-commercial-heartbeat/v1",
    keyId: "merchant-pc-01",
    watcherVersion: "0.1.0",
    state: "healthy",
    outboxPending: 0,
    ...replacements,
  });
}

function receiptBody(
  amountFen: number,
  replacements: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    schema: "wechat-commercial-receipt/v1",
    keyId: "merchant-pc-01",
    eventId: "event_01JSTATICPAYMENT",
    sequence: 1,
    observedAt: new Date(START_TIME + 20_000).toISOString(),
    paidAt: new Date(START_TIME + 10_000).toISOString(),
    amountFen,
    currency: "CNY",
    source: "wechat-commercial",
    messageFingerprint: `sha256:${"a".repeat(64)}`,
    ...replacements,
  });
}

test("merchant bridge requires a fresh healthy signed heartbeat", () => {
  const { advance, bridge, database, keys } = setup();
  try {
    assert.deepEqual(bridge.availability(), {
      available: false,
      reason: "PAYMENT_WATCHER_OFFLINE",
    });
    const body = heartbeatBody();
    bridge.processHeartbeat(
      signedHeaders({
        body,
        path: HEARTBEAT_PATH,
        privateKey: keys.privateKey,
      }),
      body,
    );
    assert.deepEqual(bridge.availability(), {
      available: true,
      reason: null,
    });

    advance(121_000);
    assert.deepEqual(bridge.availability(), {
      available: false,
      reason: "PAYMENT_WATCHER_OFFLINE",
    });
  } finally {
    database.close();
  }
});

test("merchant bridge rejects tampered, stale, and path-replayed requests", () => {
  const { bridge, database, keys } = setup();
  try {
    const body = heartbeatBody();
    const validHeaders = signedHeaders({
      body,
      path: HEARTBEAT_PATH,
      privateKey: keys.privateKey,
    });
    assert.throws(
      () => bridge.processHeartbeat(validHeaders, `${body} `),
      /MERCHANT_SIGNATURE_INVALID/,
    );
    assert.throws(
      () =>
        bridge.processHeartbeat(
          signedHeaders({
            body,
            path: RECEIPT_PATH,
            privateKey: keys.privateKey,
          }),
          body,
        ),
      /MERCHANT_SIGNATURE_INVALID/,
    );
    assert.throws(
      () =>
        bridge.processHeartbeat(
          signedHeaders({
            body,
            path: HEARTBEAT_PATH,
            privateKey: keys.privateKey,
            timestamp: Math.floor(START_TIME / 1000) - 301,
          }),
          body,
        ),
      /MERCHANT_SIGNATURE_INVALID/,
    );
    assert.throws(
      () =>
        bridge.processHeartbeat(
          signedHeaders({
            body,
            keyId: "unknown-watcher",
            path: HEARTBEAT_PATH,
            privateKey: keys.privateKey,
          }),
          body,
        ),
      /MERCHANT_SIGNATURE_INVALID/,
    );
  } finally {
    database.close();
  }
});

test("merchant bridge matches one signed receipt and replays idempotently", () => {
  const { bridge, database, keys, licensing } = setup();
  try {
    const order = licensing.createOrder(
      "device-static-bridge",
      "pro_monthly",
      "wechat-static-qr",
    );
    const body = receiptBody(order.amountFen);
    const first = bridge.processReceipt(
      signedHeaders({
        body,
        nonce: "nonce_first_123456789",
        path: RECEIPT_PATH,
        privateKey: keys.privateKey,
      }),
      body,
    );
    const replay = bridge.processReceipt(
      signedHeaders({
        body,
        nonce: "nonce_replay_12345678",
        path: RECEIPT_PATH,
        privateKey: keys.privateKey,
      }),
      body,
    );

    assert.equal(first.status, "matched");
    assert.equal(first.isReplay, false);
    assert.equal(first.matchedOrderId, order.id);
    assert.equal(first.entitlement?.planId, "pro_monthly");
    assert.equal(replay.status, "matched");
    assert.equal(replay.isReplay, true);
    assert.deepEqual(replay.entitlement, first.entitlement);
    assert.equal(licensing.getOrder(order.id, order.pollToken)?.status, "paid");
  } finally {
    database.close();
  }
});

test("merchant bridge rejects nonce, sequence, and fingerprint replay", () => {
  const { bridge, database, keys, licensing } = setup();
  try {
    const order = licensing.createOrder(
      "device-static-replay",
      "pro_monthly",
      "wechat-static-qr",
    );
    const body = receiptBody(order.amountFen);
    bridge.processReceipt(
      signedHeaders({
        body,
        nonce: "nonce_duplicate_12345",
        path: RECEIPT_PATH,
        privateKey: keys.privateKey,
      }),
      body,
    );

    const newEvent = receiptBody(order.amountFen, {
      eventId: "event_01JSTATICSECOND",
      messageFingerprint: `sha256:${"b".repeat(64)}`,
    });
    assert.throws(
      () =>
        bridge.processReceipt(
          signedHeaders({
            body: newEvent,
            nonce: "nonce_duplicate_12345",
            path: RECEIPT_PATH,
            privateKey: keys.privateKey,
          }),
          newEvent,
        ),
      /RECEIPT_NONCE_REPLAY/,
    );

    const repeatedSequence = receiptBody(order.amountFen, {
      eventId: "event_01JSTATICTHIRD",
      messageFingerprint: `sha256:${"c".repeat(64)}`,
    });
    assert.throws(
      () =>
        bridge.processReceipt(
          signedHeaders({
            body: repeatedSequence,
            nonce: "nonce_sequence_123456",
            path: RECEIPT_PATH,
            privateKey: keys.privateKey,
          }),
          repeatedSequence,
        ),
      /RECEIPT_EVENT_REPLAY_MISMATCH/,
    );

    const repeatedFingerprint = receiptBody(order.amountFen, {
      eventId: "event_01JSTATICFOURTH",
      sequence: 4,
    });
    assert.throws(
      () =>
        bridge.processReceipt(
          signedHeaders({
            body: repeatedFingerprint,
            nonce: "nonce_fingerprint_1234",
            path: RECEIPT_PATH,
            privateKey: keys.privateKey,
          }),
          repeatedFingerprint,
        ),
      /RECEIPT_EVENT_REPLAY_MISMATCH/,
    );
  } finally {
    database.close();
  }
});

test("merchant bridge leaves wrong, expired, or ambiguous receipts unmatched", () => {
  const { advance, bridge, database, keys, licensing } = setup();
  try {
    const firstOrder = licensing.createOrder(
      "device-static-ambiguous-1",
      "pro_monthly",
      "wechat-static-qr",
    );
    const secondOrder = licensing.createOrder(
      "device-static-ambiguous-2",
      "pro_monthly",
      "wechat-static-qr",
    );
    database
      .prepare("UPDATE orders SET amount_fen = ? WHERE id = ?")
      .run(firstOrder.amountFen, secondOrder.id);

    const ambiguousBody = receiptBody(firstOrder.amountFen);
    const ambiguous = bridge.processReceipt(
      signedHeaders({
        body: ambiguousBody,
        nonce: "nonce_ambiguous_12345",
        path: RECEIPT_PATH,
        privateKey: keys.privateKey,
      }),
      ambiguousBody,
    );
    assert.equal(ambiguous.status, "unmatched");
    assert.equal(
      licensing.getOrder(firstOrder.id, firstOrder.pollToken)?.status,
      "pending",
    );
    assert.equal(
      licensing.getOrder(secondOrder.id, secondOrder.pollToken)?.status,
      "pending",
    );

    const wrongBody = receiptBody(1, {
      eventId: "event_01JSTATICWRONG",
      sequence: 2,
      messageFingerprint: `sha256:${"d".repeat(64)}`,
    });
    assert.equal(
      bridge.processReceipt(
        signedHeaders({
          body: wrongBody,
          nonce: "nonce_wrong_123456789",
          path: RECEIPT_PATH,
          privateKey: keys.privateKey,
        }),
        wrongBody,
      ).status,
      "unmatched",
    );

    const expiredPaidAt = firstOrder.expiresAt + 2 * 60 * 1000 + 1;
    advance(expiredPaidAt + 1 - START_TIME);
    const expiredBody = receiptBody(firstOrder.amountFen, {
      eventId: "event_01JSTATICEXPIRED",
      sequence: 3,
      paidAt: new Date(expiredPaidAt).toISOString(),
      observedAt: new Date(expiredPaidAt + 1).toISOString(),
      messageFingerprint: `sha256:${"e".repeat(64)}`,
    });
    assert.equal(
      bridge.processReceipt(
        signedHeaders({
          body: expiredBody,
          nonce: "nonce_expired_1234567",
          path: RECEIPT_PATH,
          privateKey: keys.privateKey,
          timestamp: Math.floor((expiredPaidAt + 1) / 1000),
        }),
        expiredBody,
      ).status,
      "unmatched",
    );
  } finally {
    database.close();
  }
});
