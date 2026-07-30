import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyLike,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { EntitlementSigner } from "../src/entitlements.js";
import { StaticQrPaymentProvider } from "../src/payments/staticQr.js";
import { StaticQrBridge } from "../src/payments/staticQrBridge.js";
import { createLicensingServer } from "../src/server.js";

const START_TIME = Date.UTC(2026, 6, 30, 12);
const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

function setup() {
  let currentTime = START_TIME;
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => currentTime,
    randomId: (prefix) => `${prefix}_server_${++sequence}`,
  });
  const entitlementKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new EntitlementSigner(
    entitlementKeys.privateKey,
    entitlementKeys.publicKey,
    {
      keyId: "license-key-2026-07",
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
      randomTokenId: () => `entitlement_${++sequence}`,
    },
  );
  const watcherKeys = generateKeyPairSync("ed25519");
  const bridge = new StaticQrBridge(
    {
      store,
      licensing,
      watcherPublicKeys: new Map([["merchant-pc-01", watcherKeys.publicKey]]),
    },
    { now: () => currentTime },
  );
  const server = createLicensingServer({
    licensing,
    signer,
    paymentProvider: new StaticQrPaymentProvider(QR_DATA_URL),
    staticQrBridge: bridge,
    sourceUrl: "https://github.com/example/licensing-source",
    now: () => currentTime,
  });
  return {
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
    bridge,
    database,
    server,
    watcherKeys,
  };
}

async function listen(server: ReturnType<typeof createLicensingServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function merchantHeaders(input: {
  body: string;
  nonce: string;
  path: string;
  privateKey: KeyLike;
  timestamp: number;
}): Record<string, string> {
  const digest = createHash("sha256")
    .update(input.body, "utf8")
    .digest("base64url");
  const message = [
    "POST",
    input.path,
    String(input.timestamp),
    input.nonce,
    digest,
    "",
  ].join("\n");
  return {
    "Content-Type": "application/json",
    "X-Receipt-Key-Id": "merchant-pc-01",
    "X-Receipt-Timestamp": String(input.timestamp),
    "X-Receipt-Nonce": input.nonce,
    "X-Receipt-Signature": sign(
      null,
      Buffer.from(message, "utf8"),
      input.privateKey,
    ).toString("base64url"),
  };
}

test("static QR server gates orders and completes a signed receipt flow", async () => {
  const { advance, database, server, watcherKeys } = setup();
  try {
    const baseUrl = await listen(server);
    const unavailableCatalog = await fetch(`${baseUrl}/v1/catalog`);
    assert.deepEqual(
      ((await unavailableCatalog.json()) as Record<string, unknown>).payment,
      {
        provider: "wechat-static-qr",
        available: false,
        reason: "PAYMENT_WATCHER_OFFLINE",
      },
    );

    const blockedOrder = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-static-server",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    assert.equal(blockedOrder.status, 503);
    assert.equal(
      ((await blockedOrder.json()) as { error: { code: string } }).error.code,
      "PAYMENT_WATCHER_OFFLINE",
    );

    const heartbeat = JSON.stringify({
      schema: "wechat-commercial-heartbeat/v1",
      keyId: "merchant-pc-01",
      watcherVersion: "0.1.0",
      state: "healthy",
      outboxPending: 0,
    });
    const heartbeatResponse = await fetch(`${baseUrl}/v1/merchant/heartbeat`, {
      method: "POST",
      headers: merchantHeaders({
        body: heartbeat,
        nonce: "nonce_heartbeat_12345",
        path: "/v1/merchant/heartbeat",
        privateKey: watcherKeys.privateKey,
        timestamp: Math.floor(START_TIME / 1000),
      }),
      body: heartbeat,
    });
    assert.equal(heartbeatResponse.status, 200);

    const availableCatalog = await fetch(`${baseUrl}/v1/catalog`);
    assert.deepEqual(
      ((await availableCatalog.json()) as Record<string, unknown>).payment,
      {
        provider: "wechat-static-qr",
        available: true,
        reason: null,
      },
    );

    const createdResponse = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-static-server",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      amountFen: number;
      baseAmountFen: number;
      orderId: string;
      pollToken: string;
      qrDataUrl: string;
    };
    assert.equal(created.amountFen, 1990);
    assert.equal(created.baseAmountFen, 1990);
    assert.equal(created.qrDataUrl, QR_DATA_URL);

    const receipt = JSON.stringify({
      schema: "wechat-commercial-receipt/v1",
      keyId: "merchant-pc-01",
      eventId: "event_01JSTATICSERVER",
      sequence: 1,
      observedAt: new Date(START_TIME + 20_000).toISOString(),
      paidAt: new Date(START_TIME + 10_000).toISOString(),
      amountFen: created.amountFen,
      currency: "CNY",
      source: "wechat-commercial",
      messageFingerprint: `sha256:${"a".repeat(64)}`,
    });
    const receiptResponse = await fetch(`${baseUrl}/v1/merchant/receipts`, {
      method: "POST",
      headers: merchantHeaders({
        body: receipt,
        nonce: "nonce_receipt_1234567",
        path: "/v1/merchant/receipts",
        privateKey: watcherKeys.privateKey,
        timestamp: Math.floor(START_TIME / 1000),
      }),
      body: receipt,
    });
    assert.equal(receiptResponse.status, 202);
    assert.deepEqual(await receiptResponse.json(), {
      accepted: true,
      status: "matched",
      replay: false,
    });

    const polled = await fetch(`${baseUrl}/v1/orders/${created.orderId}`, {
      headers: { Authorization: `Bearer ${created.pollToken}` },
    });
    assert.equal(polled.status, 200);
    const paid = (await polled.json()) as Record<string, unknown>;
    assert.equal(paid.status, "paid");
    assert.equal(typeof paid.entitlementToken, "string");

    advance(121_000);
    const staleOrder = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-static-stale",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    assert.equal(staleOrder.status, 503);
  } finally {
    server.close();
    database.close();
  }
});

test("static QR merchant routes return generic authentication errors", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/merchant/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Receipt-Key-Id": "merchant-pc-01",
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: {
        code: "MERCHANT_AUTH_INVALID",
        message: "商户监听器认证失败。",
      },
    });
  } finally {
    server.close();
    database.close();
  }
});
