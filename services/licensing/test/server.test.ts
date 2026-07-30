import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LicensingStore } from "../src/database.js";
import { DEFAULT_PLANS, LicensingService } from "../src/domain.js";
import { EntitlementSigner } from "../src/entitlements.js";
import type {
  PaymentOrderInput,
  PaymentProvider,
} from "../src/payments/provider.js";
import { SandboxPaymentProvider } from "../src/payments/sandbox.js";
import { createLicensingServer } from "../src/server.js";

const now = Date.UTC(2026, 6, 29, 12);

function setup(clock: () => number = () => now) {
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: clock,
    randomId: (prefix) => `${prefix}_test_${++sequence}`,
  });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new EntitlementSigner(keys.privateKey, keys.publicKey, {
    keyId: "license-key-2026-07",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    randomTokenId: () => `entitlement_${++sequence}`,
  });
  const paymentInputs: PaymentOrderInput[] = [];
  const paymentProvider: PaymentProvider = {
    kind: "wechat-native",
    async createPayment(input) {
      paymentInputs.push(input);
      return {
        providerOrderId: input.orderId,
        codeUrl: "weixin://wxpay/bizpayurl?pr=test",
      };
    },
  };
  const server = createLicensingServer({
    licensing,
    signer,
    paymentProvider,
    sourceUrl: "https://github.com/example/licensing-source",
    now: clock,
  });
  return {
    database,
    licensing,
    paymentInputs,
    server,
  };
}

async function listen(server: ReturnType<typeof createLicensingServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("serves a stable catalog and security headers", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/catalog`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(
      response.headers.get("content-security-policy") || "",
      /default-src 'none'/,
    );
    assert.deepEqual(await response.json(), {
      trialDays: 7,
      plans: DEFAULT_PLANS,
    });
  } finally {
    server.close();
    database.close();
  }
});

test("serves a minimal health check without operational secrets", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    server.close();
    database.close();
  }
});

test("publishes the corresponding source location for network users", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/about`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: "Zotero AI Guided Reader licensing service",
      license: "AGPL-3.0-or-later",
      sourceUrl: "https://github.com/example/licensing-source",
    });
  } finally {
    server.close();
    database.close();
  }
});

test("starts a trial and creates a server-priced QR order", async () => {
  const { database, paymentInputs, server } = setup();
  try {
    const baseUrl = await listen(server);
    const trialResponse = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
      }),
    });
    assert.equal(trialResponse.status, 201);
    const trial = (await trialResponse.json()) as Record<string, unknown>;
    assert.equal(trial.status, "trial");
    assert.equal(typeof trial.entitlementToken, "string");

    const invalidPrice = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
        amountFen: 1,
      }),
    });
    assert.equal(invalidPrice.status, 422);

    const orderResponse = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    assert.equal(orderResponse.status, 201);
    const order = (await orderResponse.json()) as Record<string, unknown>;
    assert.equal(order.amountFen, 1990);
    assert.match(String(order.qrDataUrl), /^data:image\/png;base64,/);
    assert.equal(paymentInputs[0]?.amountFen, 1990);
    assert.equal(typeof order.pollToken, "string");
  } finally {
    server.close();
    database.close();
  }
});

test("never reissues an existing paid entitlement through the trial endpoint", async () => {
  const { database, licensing, server } = setup();
  try {
    const baseUrl = await listen(server);
    const createdResponse = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    const created = (await createdResponse.json()) as {
      orderId: string;
      amountFen: number;
    };
    licensing.recordPayment({
      orderId: created.orderId,
      transactionId: "wechat-tx-pro-reissue",
      amountFen: created.amountFen,
      paidAt: now,
    });

    const trialResponse = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
      }),
    });
    assert.equal(trialResponse.status, 409);
    const body = (await trialResponse.json()) as {
      error: { code: string };
    };
    assert.equal(body.error.code, "ENTITLEMENT_EXISTS");
  } finally {
    server.close();
    database.close();
  }
});

test("limits trial abuse even when the caller changes device identifiers", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    for (let index = 0; index < 20; index += 1) {
      const response = await fetch(`${baseUrl}/v1/trials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: `device-abuse-${index}`,
          clientVersion: "0.1.0",
        }),
      });
      assert.equal(response.status, 201);
    }
    const blocked = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-abuse-21",
        clientVersion: "0.1.0",
      }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "3600");
  } finally {
    server.close();
    database.close();
  }
});

test("polls with a bearer token and returns an entitlement only after payment", async () => {
  const { database, licensing, server } = setup();
  try {
    const baseUrl = await listen(server);
    const createdResponse = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        planId: "pro_yearly",
      }),
    });
    const created = (await createdResponse.json()) as {
      orderId: string;
      pollToken: string;
      amountFen: number;
    };

    const unauthorized = await fetch(
      `${baseUrl}/v1/orders/${created.orderId}`,
      { headers: { Authorization: "Bearer wrong-token" } },
    );
    assert.equal(unauthorized.status, 404);

    const pendingResponse = await fetch(
      `${baseUrl}/v1/orders/${created.orderId}`,
      { headers: { Authorization: `Bearer ${created.pollToken}` } },
    );
    assert.deepEqual(await pendingResponse.json(), {
      orderId: created.orderId,
      status: "pending",
      expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    });

    licensing.recordPayment({
      orderId: created.orderId,
      transactionId: "wechat-tx-1",
      amountFen: created.amountFen,
      paidAt: now,
    });
    const paidResponse = await fetch(
      `${baseUrl}/v1/orders/${created.orderId}`,
      { headers: { Authorization: `Bearer ${created.pollToken}` } },
    );
    const paid = (await paidResponse.json()) as Record<string, unknown>;
    assert.equal(paid.status, "paid");
    assert.equal(typeof paid.entitlementToken, "string");
  } finally {
    server.close();
    database.close();
  }
});

test("uses structured errors without leaking internal details", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const wrongType = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
    assert.deepEqual(await wrongType.json(), {
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "请求必须使用 application/json。",
      },
    });

    const malformed = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    const body = JSON.stringify(await malformed.json());
    assert.doesNotMatch(body, /SyntaxError|stack|sqlite/i);
  } finally {
    server.close();
    database.close();
  }
});

test("refreshes only a valid signed entitlement for the same device", async () => {
  const { database, server } = setup();
  try {
    const baseUrl = await listen(server);
    const trialResponse = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
      }),
    });
    const trial = (await trialResponse.json()) as {
      entitlementToken: string;
    };

    const refreshedResponse = await fetch(
      `${baseUrl}/v1/entitlements/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-123",
          clientVersion: "0.1.0",
          entitlementToken: trial.entitlementToken,
        }),
      },
    );
    assert.equal(refreshedResponse.status, 200);
    assert.equal(
      typeof ((await refreshedResponse.json()) as Record<string, unknown>)
        .entitlementToken,
      "string",
    );

    const wrongDevice = await fetch(`${baseUrl}/v1/entitlements/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-999",
        clientVersion: "0.1.0",
        entitlementToken: trial.entitlementToken,
      }),
    });
    assert.equal(wrongDevice.status, 401);

    const tampered = await fetch(`${baseUrl}/v1/entitlements/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        entitlementToken: `${trial.entitlementToken}x`,
      }),
    });
    assert.equal(tampered.status, 401);
  } finally {
    server.close();
    database.close();
  }
});

test("refuses to resurrect a fully expired signed entitlement", async () => {
  let currentTime = now;
  const { database, server } = setup(() => currentTime);
  try {
    const baseUrl = await listen(server);
    const trialResponse = await fetch(`${baseUrl}/v1/trials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
      }),
    });
    const trial = (await trialResponse.json()) as {
      entitlementToken: string;
    };
    currentTime += 8 * 24 * 60 * 60 * 1000;

    const refreshedResponse = await fetch(
      `${baseUrl}/v1/entitlements/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "device-123",
          clientVersion: "0.1.0",
          entitlementToken: trial.entitlementToken,
        }),
      },
    );
    assert.equal(refreshedResponse.status, 401);
    const body = (await refreshedResponse.json()) as {
      error: { code: string };
    };
    assert.equal(body.error.code, "ENTITLEMENT_INVALID");
  } finally {
    server.close();
    database.close();
  }
});

test("completes the sandbox QR flow only with its signed proof", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new LicensingStore(database);
  let sequence = 0;
  const licensing = new LicensingService({
    store,
    plans: DEFAULT_PLANS,
    now: () => now,
    randomId: (prefix) => `${prefix}_sandbox_${++sequence}`,
  });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = new EntitlementSigner(keys.privateKey, keys.publicKey, {
    keyId: "license-key-2026-07",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    randomTokenId: () => `entitlement_${++sequence}`,
  });
  const sandbox = new SandboxPaymentProvider(
    "http://127.0.0.1:8787",
    "sandbox-secret-with-at-least-32-bytes",
  );
  const server = createLicensingServer({
    licensing,
    signer,
    paymentProvider: sandbox,
    sandboxPaymentProvider: sandbox,
    sourceUrl: "https://github.com/example/licensing-source",
    now: () => now,
  });
  try {
    const baseUrl = await listen(server);
    const createdResponse = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-123",
        clientVersion: "0.1.0",
        planId: "pro_monthly",
      }),
    });
    const created = (await createdResponse.json()) as {
      orderId: string;
      pollToken: string;
    };
    const proof = sandbox.createProof(created.orderId);

    const rejected = await fetch(
      `${baseUrl}/v1/sandbox/pay/${created.orderId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "proof=wrong",
      },
    );
    assert.equal(rejected.status, 404);

    const page = await fetch(
      `${baseUrl}/v1/sandbox/pay/${created.orderId}?proof=${proof}`,
    );
    assert.equal(page.status, 200);
    assert.match(await page.text(), /不会产生真实扣款/);

    const paid = await fetch(`${baseUrl}/v1/sandbox/pay/${created.orderId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ proof }),
    });
    assert.equal(paid.status, 200);

    const polled = await fetch(`${baseUrl}/v1/orders/${created.orderId}`, {
      headers: { Authorization: `Bearer ${created.pollToken}` },
    });
    assert.equal(
      ((await polled.json()) as Record<string, unknown>).status,
      "paid",
    );
  } finally {
    server.close();
    database.close();
  }
});
