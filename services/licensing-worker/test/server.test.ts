import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pemFromDer } from "../src/crypto";
import { createWorkerApp } from "../src/index";
import type { WorkerEnv } from "../src/config";

const NOW = Date.UTC(2026, 7, 11, 8);
let workerEnv: WorkerEnv;
let afdianPrivateKey: CryptoKey;
let afdianPublicPem: string;

beforeAll(async () => {
  const entitlementPair = await generatePair();
  const entitlementDer = await crypto.subtle.exportKey(
    "pkcs8",
    entitlementPair.privateKey,
  );
  const afdianPair = await generatePair();
  afdianPrivateKey = afdianPair.privateKey;
  afdianPublicPem = pemFromDer(
    await crypto.subtle.exportKey("spki", afdianPair.publicKey),
    "PUBLIC KEY",
  );
  workerEnv = {
    DB: env.DB,
    LICENSE_ISSUER: "https://license.example.test",
    LICENSE_AUDIENCE: "zotero-ai-guided-reader",
    LICENSE_KEY_ID: "license-key-2026-08",
    LICENSE_PRIVATE_KEY_PEM: pemFromDer(entitlementDer, "PRIVATE KEY"),
    SOURCE_URL: "https://github.com/example/licensing-source",
    RATE_LIMIT_PEPPER: "test-only-rate-limit-pepper-32-bytes",
    AFDIAN_USER_ID: "0123456789abcdef0123456789abcdef",
    AFDIAN_API_TOKEN: "test-only-afdian-token-32-bytes-long",
    AFDIAN_MONTHLY_PLAN_ID: "11111111111111111111111111111111",
    AFDIAN_YEARLY_PLAN_ID: "22222222222222222222222222222222",
  };
});

describe("licensing Worker API", () => {
  it("serves health, about, and the server-owned catalog with security headers", async () => {
    const app = createWorkerApp({ now: () => NOW });
    const health = await app.request("/healthz", {}, workerEnv);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("access-control-allow-origin")).toBeNull();

    const about = await app.request("/v1/about", {}, workerEnv);
    expect(await about.json()).toMatchObject({
      license: "AGPL-3.0-or-later",
      sourceUrl: workerEnv.SOURCE_URL,
    });
    const catalog = await app.request("/v1/catalog", {}, workerEnv);
    expect(await catalog.json()).toMatchObject({
      trialDays: 7,
      plans: [
        { id: "pro_monthly", durationDays: 30, priceFen: 590 },
        { id: "pro_yearly", durationDays: 365, priceFen: 4900 },
      ],
      payment: { provider: "afdian", available: true },
    });
  });

  it("issues and refreshes a seven-day trial for the same device", async () => {
    const app = createWorkerApp({ now: () => NOW });
    const issued = await jsonRequest(app, "/v1/trials", {
      deviceId: "device_server_trial_001",
      clientVersion: "0.1.0",
    });
    expect(issued.response.status).toBe(201);
    expect(issued.body).toMatchObject({
      status: "trial",
      validUntil: new Date(NOW + 7 * 86_400_000).toISOString(),
    });
    expect(String(issued.body.entitlementToken)).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);

    const refreshed = await jsonRequest(app, "/v1/entitlements/refresh", {
      deviceId: "device_server_trial_001",
      clientVersion: "0.1.0",
      entitlementToken: issued.body.entitlementToken,
    });
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      status: "trial",
      validUntil: issued.body.validUntil,
    });
  });

  it("creates monthly and yearly checkout links without exposing secrets", async () => {
    const app = createWorkerApp({ now: () => NOW });
    for (const [planId, configuredPlan] of [
      ["pro_monthly", workerEnv.AFDIAN_MONTHLY_PLAN_ID],
      ["pro_yearly", workerEnv.AFDIAN_YEARLY_PLAN_ID],
    ] as const) {
      const created = await jsonRequest(app, "/v1/orders", {
        deviceId: `device_${planId}_001`,
        clientVersion: "0.1.0",
        planId,
      });
      expect(created.response.status).toBe(201);
      const checkout = new URL(String(created.body.checkoutUrl));
      expect(checkout.origin).toBe("https://ifdian.net");
      expect(checkout.pathname).toBe("/order/create");
      expect(checkout.searchParams.get("plan_id")).toBe(configuredPlan);
      expect(checkout.searchParams.get("custom_order_id")).toMatch(/^co_/);
      const serialized = JSON.stringify(created.body);
      expect(serialized).not.toContain(workerEnv.AFDIAN_API_TOKEN);
      expect(serialized).not.toContain("PRIVATE KEY");
    }
  });

  it("activates only after a signed webhook and matching API query", async () => {
    let expectedOrder: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async () =>
      Response.json({ ec: 200, em: "", data: { list: [expectedOrder] } }),
    );
    const app = createWorkerApp({
      now: () => NOW,
      fetcher,
      afdianPublicKeyPem: afdianPublicPem,
    });
    const created = await jsonRequest(app, "/v1/orders", {
      deviceId: "device_webhook_001",
      clientVersion: "0.1.0",
      planId: "pro_monthly",
    });
    const checkout = new URL(String(created.body.checkoutUrl));
    expectedOrder = {
      out_trade_no: "202608110000000000000099",
      custom_order_id: checkout.searchParams.get("custom_order_id"),
      user_id: "33333333333333333333333333333333",
      plan_id: workerEnv.AFDIAN_MONTHLY_PLAN_ID,
      total_amount: "5.90",
      status: 2,
      product_type: 0,
      create_time: Math.floor(NOW / 1000) + 60,
    };
    const webhook = await signedWebhook(expectedOrder);

    const accepted = await jsonRequest(app, "/v1/webhooks/afdian", webhook);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body).toEqual({ ec: 200, em: "" });
    expect(fetcher).toHaveBeenCalledOnce();

    const poll = await app.request(
      `/v1/orders/${created.body.orderId}`,
      { headers: { authorization: `Bearer ${created.body.pollToken}` } },
      workerEnv,
    );
    expect(await poll.json()).toMatchObject({
      orderId: created.body.orderId,
      status: "paid",
      entitlementToken: expect.any(String),
    });

    const replay = await jsonRequest(app, "/v1/webhooks/afdian", webhook);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual({ ec: 200, em: "" });
  });

  it("rejects forged webhooks, wrong methods, unknown fields, and bad content types", async () => {
    const app = createWorkerApp({
      now: () => NOW,
      fetcher: async () => {
        throw new Error("must not query for a forged callback");
      },
      afdianPublicKeyPem: afdianPublicPem,
    });
    const forged = await jsonRequest(app, "/v1/webhooks/afdian", {
      ec: 200,
      em: "ok",
      sign: "Zm9yZ2Vk",
      data: {
        type: "order",
        order: {
          out_trade_no: "202608110000000000000088",
          custom_order_id: "co_123456789012345678901234",
          user_id: "33333333333333333333333333333333",
          plan_id: workerEnv.AFDIAN_MONTHLY_PLAN_ID,
          total_amount: "5.90",
          status: 2,
          product_type: 0,
        },
      },
    });
    expect(forged.response.status).toBe(401);
    expect(forged.body).toMatchObject({ error: { code: "INVALID_WEBHOOK" } });

    expect((await app.request("/v1/trials", {}, workerEnv)).status).toBe(405);
    expect(
      (
        await app.request(
          "/v1/trials",
          {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          },
          workerEnv,
        )
      ).status,
    ).toBe(415);
    const unknown = await jsonRequest(app, "/v1/trials", {
      deviceId: "device_unknown_001",
      clientVersion: "0.1.0",
      priceFen: 1,
    });
    expect(unknown.response.status).toBe(400);
  });
});

async function jsonRequest(
  app: ReturnType<typeof createWorkerApp>,
  path: string,
  body: unknown,
) {
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    workerEnv,
  );
  return {
    response,
    body: (await response.json()) as Record<string, any>,
  };
}

async function signedWebhook(order: Record<string, unknown>) {
  const signed = `${order.out_trade_no}${order.user_id}${order.plan_id}${order.total_amount}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    afdianPrivateKey,
    new TextEncoder().encode(signed),
  );
  return {
    ec: 200,
    em: "ok",
    sign: bytesToBase64(new Uint8Array(signature)),
    data: { type: "order", order },
  };
}

async function generatePair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
