import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { EntitlementSigner } from "../src/entitlements.js";
import { createChinaumsNotificationSignature } from "../src/payments/chinaumsAuth.js";
import { ChinaumsQrProvider } from "../src/payments/chinaumsQr.js";
import { ChinaumsWebhookProcessor } from "../src/payments/chinaumsWebhook.js";
import { createLicensingServer } from "../src/server.js";

const initialNow = Date.UTC(2026, 7, 10, 12, 34, 56);
const merchantId = "898201612345678";
const terminalId = "88880001";
const notificationKey = "independent-notification-key";

function setup() {
  let currentNow = initialNow;
  let queryState: "pending" | "paid" = "pending";
  let queryCalls = 0;
  let billNo = "";
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => currentNow,
    randomId: (prefix) => `${prefix}_chinaums_${++sequence}`,
  });
  const provider = new ChinaumsQrProvider(
    {
      environment: "test",
      appId: "app-id-123",
      appKey: "application-secret-value",
      merchantId,
      terminalId,
      messageSourceId: "AB12",
      notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
    },
    (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(url).endsWith("/v1/netpay/bills/get-qrcode")) {
        billNo = String(body.billNo);
        return jsonResponse({
          errCode: "SUCCESS",
          mid: merchantId,
          tid: terminalId,
          instMid: "QRPAYDEFAULT",
          billNo,
          billDate: body.billDate,
          billQRCode: "https://qr-test2.chinaums.com/bills/qrCode.do?id=qr_123",
        });
      }
      if (String(url).endsWith("/v1/netpay/bills/query")) {
        queryCalls += 1;
        return jsonResponse({
          errCode: "SUCCESS",
          mid: merchantId,
          tid: terminalId,
          instMid: "QRPAYDEFAULT",
          billNo,
          billDate: body.billDate,
          billStatus: queryState === "paid" ? "PAID" : "UNPAID",
          totalAmount: 1990,
          ...(queryState === "paid"
            ? {
                billPayment: {
                  paySeqId: "QUERYSEQ001",
                  payTime: "2026-08-10 20:35:00",
                  status: "TRADE_SUCCESS",
                },
              }
            : {}),
        });
      }
      throw new Error("Unexpected ChinaUMS test endpoint.");
    }) as typeof fetch,
    {
      now: () => currentNow,
      nonce: () => `nonce_${++sequence}`,
      randomDigits: () => "0000001",
    },
  );
  const webhook = new ChinaumsWebhookProcessor(
    { merchantId, terminalId, notificationKey },
    licensing,
    { now: () => currentNow },
  );
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new EntitlementSigner(keys.privateKey, keys.publicKey, {
    keyId: "license-key-2026-08",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    randomTokenId: () => `entitlement_${++sequence}`,
  });
  const server = createLicensingServer({
    licensing,
    signer,
    paymentProvider: provider,
    chinaumsPaymentProvider: provider,
    chinaumsWebhookProcessor: webhook,
    sourceUrl: "https://github.com/example/licensing-source",
    now: () => currentNow,
  });
  return {
    database,
    licensing,
    server,
    getBillNo: () => billNo,
    getQueryCalls: () => queryCalls,
    setQueryState: (value: "pending" | "paid") => {
      queryState = value;
    },
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

async function listen(server: ReturnType<typeof createLicensingServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function createMonthlyOrder(baseUrl: string) {
  const response = await fetch(`${baseUrl}/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "device-chinaums",
      clientVersion: "0.1.0",
      planId: "pro_monthly",
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as {
    orderId: string;
    pollToken: string;
    amountFen: number;
    qrDataUrl: string;
  };
}

function signedCallback(billNo: string): string {
  const fields = new Map<string, string>([
    ["billNo", billNo],
    ["billDate", "2026-08-10"],
    ["billStatus", "PAID"],
    ["totalAmount", "1990"],
    ["notifyId", "notify_server_123"],
    ["seqId", "OUTERSEQ001"],
    ["mid", merchantId],
    ["tid", terminalId],
    ["instMid", "QRPAYDEFAULT"],
    [
      "billPayment",
      JSON.stringify({
        paySeqId: "CALLBACKSEQ001",
        payTime: "2026-08-10 20:35:00",
        status: "TRADE_SUCCESS",
      }),
    ],
    ["signType", "SHA256"],
  ]);
  fields.set(
    "sign",
    createChinaumsNotificationSignature(fields, notificationKey),
  );
  return new URLSearchParams([...fields]).toString();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("ChinaUMS server binds the bill and acknowledges a verified callback", async () => {
  const context = setup();
  try {
    const baseUrl = await listen(context.server);
    const order = await createMonthlyOrder(baseUrl);
    assert.match(order.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(
      context.licensing.getOrder(order.orderId, order.pollToken)
        ?.providerOrderId,
      context.getBillNo(),
    );

    const callbackBody = signedCallback(context.getBillNo());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const callback = await fetch(`${baseUrl}/v1/webhooks/chinaums`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: callbackBody,
      });
      assert.equal(callback.status, 200);
      assert.equal(
        callback.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assert.equal(await callback.text(), "SUCCESS");
    }

    const invalid = await fetch(`${baseUrl}/v1/webhooks/chinaums`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: callbackBody.replace("totalAmount=1990", "totalAmount=1991"),
    });
    assert.equal(invalid.status, 400);
    assert.equal(await invalid.text(), "FAILED");

    const poll = await fetch(`${baseUrl}/v1/orders/${order.orderId}`, {
      headers: { Authorization: `Bearer ${order.pollToken}` },
    });
    const result = (await poll.json()) as Record<string, unknown>;
    assert.equal(result.status, "paid");
    assert.equal(typeof result.entitlementToken, "string");
  } finally {
    context.server.close();
    context.database.close();
  }
});

test("ChinaUMS server throttles bill queries and recovers a missed callback", async () => {
  const context = setup();
  try {
    const baseUrl = await listen(context.server);
    const order = await createMonthlyOrder(baseUrl);
    const poll = () =>
      fetch(`${baseUrl}/v1/orders/${order.orderId}`, {
        headers: { Authorization: `Bearer ${order.pollToken}` },
      });

    assert.equal(
      ((await (await poll()).json()) as { status: string }).status,
      "pending",
    );
    assert.equal(
      ((await (await poll()).json()) as { status: string }).status,
      "pending",
    );
    assert.equal(context.getQueryCalls(), 1);

    context.advance(5_001);
    context.setQueryState("paid");
    const recovered = (await (await poll()).json()) as Record<string, unknown>;
    assert.equal(context.getQueryCalls(), 2);
    assert.equal(recovered.status, "paid");
    assert.equal(typeof recovered.entitlementToken, "string");
    assert.equal(
      context.licensing.getOrder(order.orderId, order.pollToken)?.transactionId,
      "chinaums_QUERYSEQ001",
    );
  } finally {
    context.server.close();
    context.database.close();
  }
});
