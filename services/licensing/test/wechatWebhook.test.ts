import assert from "node:assert/strict";
import { createCipheriv, createSign, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { WechatWebhookProcessor } from "../src/payments/wechatWebhook.js";

const API_V3_KEY = "12345678901234567890123456789012";
const now = Date.UTC(2026, 6, 29, 12);
const nowSeconds = Math.floor(now / 1000);

function rsaKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

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
  const order = service.createOrder("device-1", "pro_monthly");
  const platform = rsaKeys();
  const processor = new WechatWebhookProcessor(
    {
      merchantId: "1900000001",
      appId: "wx-app-1",
      apiV3Key: API_V3_KEY,
      platformPublicKeys: new Map([["PLATFORM-SERIAL", platform.publicKey]]),
    },
    service,
    { nowSeconds: () => nowSeconds },
  );
  return { database, service, order, platform, processor };
}

function callback(input: {
  platformPrivateKey: string;
  transaction: Record<string, unknown>;
  eventId?: string;
  timestamp?: number;
}) {
  const nonce = "123456789012";
  const associatedData = "transaction";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(API_V3_KEY),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.transaction), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const rawBody = JSON.stringify({
    id: input.eventId || "event-1",
    event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      ciphertext,
      nonce,
      associated_data: associatedData,
    },
  });
  const timestamp = String(input.timestamp ?? nowSeconds);
  const requestNonce = "callback-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${requestNonce}\n${rawBody}\n`, "utf8");
  signer.end();
  return {
    rawBody,
    headers: new Headers({
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": requestNonce,
      "Wechatpay-Serial": "PLATFORM-SERIAL",
      "Wechatpay-Signature": signer
        .sign(input.platformPrivateKey)
        .toString("base64"),
    }),
  };
}

function successfulTransaction(orderId: string, amountFen: number) {
  return {
    appid: "wx-app-1",
    mchid: "1900000001",
    out_trade_no: orderId,
    transaction_id: "wechat-tx-1",
    trade_state: "SUCCESS",
    success_time: new Date(now).toISOString(),
    amount: { total: amountFen, currency: "CNY" },
  };
}

test("verifies, decrypts, validates, and records a WeChat callback", () => {
  const { database, order, platform, processor } = setup();
  try {
    const request = callback({
      platformPrivateKey: platform.privateKey,
      transaction: successfulTransaction(order.id, order.amountFen),
    });
    const first = processor.process(request.headers, request.rawBody);
    const replay = processor.process(request.headers, request.rawBody);

    assert.equal(first.isReplay, false);
    assert.equal(first.entitlement.planId, "pro_monthly");
    assert.equal(replay.isReplay, true);
  } finally {
    database.close();
  }
});

test("rejects stale timestamps and tampered callback bodies", () => {
  const { database, order, platform, processor } = setup();
  try {
    const stale = callback({
      platformPrivateKey: platform.privateKey,
      transaction: successfulTransaction(order.id, order.amountFen),
      timestamp: nowSeconds - 301,
    });
    assert.throws(
      () => processor.process(stale.headers, stale.rawBody),
      /timestamp/i,
    );

    const signed = callback({
      platformPrivateKey: platform.privateKey,
      transaction: successfulTransaction(order.id, order.amountFen),
    });
    assert.throws(
      () => processor.process(signed.headers, `${signed.rawBody} `),
      /signature/i,
    );
  } finally {
    database.close();
  }
});

test("rejects merchant, app, amount, currency, and state mismatches", () => {
  const { database, order, platform, processor } = setup();
  try {
    const badValues = [
      { mchid: "attacker-merchant" },
      { appid: "attacker-app" },
      { amount: { total: order.amountFen - 1, currency: "CNY" } },
      { amount: { total: order.amountFen, currency: "USD" } },
      { trade_state: "NOTPAY" },
    ];
    for (const [index, replacement] of badValues.entries()) {
      const request = callback({
        platformPrivateKey: platform.privateKey,
        eventId: `event-${index}`,
        transaction: {
          ...successfulTransaction(order.id, order.amountFen),
          ...replacement,
        },
      });
      assert.throws(() => processor.process(request.headers, request.rawBody));
    }
  } finally {
    database.close();
  }
});
