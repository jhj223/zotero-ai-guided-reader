import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StoredOrder } from "../src/store";
import {
  assertAfdianOrderMatches,
  buildAfdianCheckoutUrl,
  createAfdianApiEnvelope,
  parseAfdianWebhook,
  queryAfdianOrder,
  queryRecentAfdianOrders,
  type AfdianOrder,
} from "../src/afdian";

const config = {
  userId: "0123456789abcdef0123456789abcdef",
  apiToken: "test-only-afdian-token-32-bytes-long",
  monthlyPlanId: "11111111111111111111111111111111",
  yearlyPlanId: "22222222222222222222222222222222",
};
const localOrder: StoredOrder = {
  id: "ord_123456789012345678901234",
  customOrderId: "co_123456789012345678901234",
  deviceId: "device_afdian_001",
  planId: "pro_monthly",
  durationDays: 30,
  amountFen: 590,
  status: "pending",
  pollTokenHash: "a".repeat(64),
  createdAt: 1_786_435_200_000,
  expiresAt: 1_786_694_400_000,
};

function providerOrder(overrides: Partial<AfdianOrder> = {}): AfdianOrder {
  return {
    outTradeNo: "202608110000000000000001",
    customOrderId: localOrder.customOrderId,
    userId: "33333333333333333333333333333333",
    planId: config.monthlyPlanId,
    totalAmount: "5.90",
    amountFen: 590,
    status: 2,
    productType: 0,
    createTime: Math.floor(localOrder.createdAt / 1000) + 60,
    ...overrides,
  };
}

function queryResponse(order: AfdianOrder): Response {
  return Response.json({
    ec: 200,
    em: "",
    data: {
      list: [
        {
          out_trade_no: order.outTradeNo,
          custom_order_id: order.customOrderId,
          user_id: order.userId,
          plan_id: order.planId,
          total_amount: order.totalAmount,
          status: order.status,
          product_type: order.productType,
          create_time: order.createTime,
        },
      ],
      total_count: 1,
      total_page: 1,
    },
  });
}

describe("Afdian adapter", () => {
  it("builds a fixed-origin checkout URL with opaque local correlation", () => {
    expect(
      buildAfdianCheckoutUrl(config.monthlyPlanId, localOrder.customOrderId),
    ).toBe(
      "https://ifdian.net/order/create?plan_id=11111111111111111111111111111111&product_type=0&custom_order_id=co_123456789012345678901234",
    );
    expect(() =>
      buildAfdianCheckoutUrl("https://evil.test", localOrder.customOrderId),
    ).toThrow(/plan/i);
    expect(() =>
      buildAfdianCheckoutUrl(config.monthlyPlanId, "javascript:alert(1)"),
    ).toThrow(/order/i);
  });

  it("uses the documented canonical MD5 API signature", () => {
    const envelope = createAfdianApiEnvelope(
      "202608110000000000000001",
      config,
      1_786_435_200,
    );
    const canonical = `${config.apiToken}params${envelope.params}ts1786435200user_id${config.userId}`;

    expect(envelope).toEqual({
      user_id: config.userId,
      params: '{"out_trade_no":"202608110000000000000001"}',
      ts: 1_786_435_200,
      sign: createHash("md5").update(canonical).digest("hex"),
    });
  });

  it("parses only the minimum webhook fields needed as an order hint", () => {
    const parsed = parseAfdianWebhook({
      ec: 200,
      em: "ok",
      data: {
        type: "order",
        order: {
          out_trade_no: providerOrder().outTradeNo,
          custom_order_id: providerOrder().customOrderId,
        },
      },
    });

    expect(parsed).toEqual({
      outTradeNo: providerOrder().outTradeNo,
      customOrderId: providerOrder().customOrderId,
    });
    expect(() => parseAfdianWebhook({ data: { type: "order" } })).toThrow();
  });

  it("requests an explicit page size and uses provider pagination metadata", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { params: string };
      expect(JSON.parse(envelope.params)).toEqual({ page: 3, per_page: 100 });
      return Response.json({
        ec: 200,
        em: "",
        data: { list: [], total_count: 201, total_page: 3 },
      });
    });

    await expect(
      queryRecentAfdianOrders(config, { page: 3, fetcher }),
    ).resolves.toEqual({ orders: [], totalPage: 3 });
  });

  it("queries one bounded order without redirects and validates exact fields", async () => {
    const order = providerOrder();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.user_id).toBe(config.userId);
      expect(body.params).toBe(`{"out_trade_no":"${order.outTradeNo}"}`);
      return queryResponse(order);
    });

    const queried = await queryAfdianOrder(order.outTradeNo, config, {
      fetcher,
      now: () => 1_786_435_200_000,
    });
    expect(queried).toEqual(order);
    expect(() =>
      assertAfdianOrderMatches(localOrder, queried!, config),
    ).not.toThrow();
  });

  it("rejects mismatched plan, amount, custom ID, and status", () => {
    for (const queried of [
      providerOrder({ planId: config.yearlyPlanId }),
      providerOrder({ totalAmount: "59.00", amountFen: 5900 }),
      providerOrder({ customOrderId: "co_999999999999999999999999" }),
      providerOrder({ status: 1 }),
      providerOrder({ productType: 1 }),
    ]) {
      expect(() =>
        assertAfdianOrderMatches(localOrder, queried, config),
      ).toThrow();
    }
  });

  it("accepts whole-yuan and one-decimal provider amounts", async () => {
    for (const totalAmount of ["49", "49.0", "49.00"]) {
      const order = providerOrder({ totalAmount, amountFen: 4_900 });
      const queried = await queryAfdianOrder(order.outTradeNo, config, {
        fetcher: async () => queryResponse(order),
      });
      expect(queried?.amountFen).toBe(4_900);
    }
  });

  it("fails closed on provider errors, wrong content, oversized bodies, and timeouts", async () => {
    await expect(
      queryAfdianOrder(providerOrder().outTradeNo, config, {
        fetcher: async () =>
          Response.json({ ec: 400005, em: "sign validation failed" }),
      }),
    ).rejects.toThrow(/provider/i);
    await expect(
      queryAfdianOrder(providerOrder().outTradeNo, config, {
        fetcher: async () => new Response("not json", { status: 200 }),
      }),
    ).rejects.toThrow(/content/i);
    await expect(
      queryAfdianOrder(providerOrder().outTradeNo, config, {
        fetcher: async () =>
          new Response("x".repeat(70_000), {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/large/i);
    await expect(
      queryAfdianOrder(providerOrder().outTradeNo, config, {
        timeoutMs: 5,
        fetcher: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      }),
    ).rejects.toThrow(/timeout/i);
  });
});
