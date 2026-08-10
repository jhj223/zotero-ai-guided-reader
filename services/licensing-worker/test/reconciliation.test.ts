import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/config";
import { pemFromDer } from "../src/crypto";
import { reconcilePendingOrders } from "../src/index";
import { LicensingService } from "../src/service";
import { LicensingStore } from "../src/store";

const NOW = Date.UTC(2026, 7, 11, 8);
let workerEnv: WorkerEnv;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  workerEnv = {
    DB: env.DB,
    LICENSE_ISSUER: "https://license.example.test",
    LICENSE_AUDIENCE: "zotero-ai-guided-reader",
    LICENSE_KEY_ID: "license-key-2026-08",
    LICENSE_PRIVATE_KEY_PEM: pemFromDer(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      "PRIVATE KEY",
    ),
    SOURCE_URL: "https://github.com/example/licensing-source",
    RATE_LIMIT_PEPPER: "test-only-rate-limit-pepper-32-bytes",
    AFDIAN_USER_ID: "0123456789abcdef0123456789abcdef",
    AFDIAN_API_TOKEN: "test-only-afdian-token-32-bytes-long",
    AFDIAN_MONTHLY_PLAN_ID: "11111111111111111111111111111111",
    AFDIAN_YEARLY_PLAN_ID: "22222222222222222222222222222222",
  };
});

describe("missed-webhook reconciliation", () => {
  it("scans recent provider orders by custom ID and completes exactly once", async () => {
    const service = new LicensingService(new LicensingStore(env.DB), () => NOW);
    const local = await service.createOrder(
      "device_reconcile_001",
      "pro_monthly",
    );
    const providerOrder = {
      out_trade_no: "202608110000000000000077",
      custom_order_id: local.customOrderId,
      user_id: "33333333333333333333333333333333",
      plan_id: workerEnv.AFDIAN_MONTHLY_PLAN_ID,
      total_amount: "5.90",
      status: 2,
      product_type: 0,
      create_time: Math.floor(NOW / 1000) + 60,
    };
    const fetcher = vi.fn(async () =>
      Response.json({ ec: 200, em: "", data: { list: [providerOrder] } }),
    );

    expect(
      await reconcilePendingOrders(workerEnv, { now: () => NOW, fetcher }),
    ).toEqual({ checked: 1, completed: 1 });
    expect(
      await reconcilePendingOrders(workerEnv, { now: () => NOW, fetcher }),
    ).toEqual({ checked: 0, completed: 0 });
    expect((await service.store.findOrder(local.orderId))?.status).toBe("paid");
  });

  it("fails closed when the provider cannot be queried", async () => {
    const service = new LicensingService(new LicensingStore(env.DB), () => NOW);
    const local = await service.createOrder(
      "device_reconcile_fail_001",
      "pro_yearly",
    );
    await expect(
      reconcilePendingOrders(workerEnv, {
        now: () => NOW,
        fetcher: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow(/query/i);
    expect((await service.store.findOrder(local.orderId))?.status).toBe("pending");
  });
});
