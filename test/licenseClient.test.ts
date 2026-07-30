import assert from "node:assert/strict";
import test from "node:test";
import { LicenseClient, type LicenseFetch } from "../src/runtime/licenseClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requires HTTPS except explicit loopback development", () => {
  const fetchImpl: LicenseFetch = async () => jsonResponse(200, {});
  assert.throws(
    () =>
      new LicenseClient({
        baseUrl: "http://license.example.com",
        clientVersion: "0.1.0",
        fetchImpl,
      }),
    /HTTPS/i,
  );
  assert.doesNotThrow(
    () =>
      new LicenseClient({
        baseUrl: "http://127.0.0.1:8787",
        clientVersion: "0.1.0",
        allowLoopbackHttp: true,
        fetchImpl,
      }),
  );
});

test("creates an order without sending a client-controlled price", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const client = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(201, {
        orderId: "order_123456",
        pollToken: "poll_12345678",
        status: "pending",
        planId: "pro_monthly",
        amountFen: 1990,
        expiresAt: "2026-07-29T12:15:00.000Z",
        qrDataUrl: "data:image/png;base64,aGVsbG8=",
      });
    },
  });

  const order = await client.createOrder("device-123", "pro_monthly");
  assert.equal(order.amountFen, 1990);
  assert.equal(captured?.url, "https://license.example.com/v1/orders");
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    deviceId: "device-123",
    clientVersion: "0.1.0",
    planId: "pro_monthly",
  });
});

test("accepts a configured JPEG merchant QR image", async () => {
  const client = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    fetchImpl: async () =>
      jsonResponse(201, {
        orderId: "order_123456",
        pollToken: "poll_12345678",
        status: "pending",
        planId: "pro_monthly",
        amountFen: 1990,
        expiresAt: "2026-07-29T12:15:00.000Z",
        qrDataUrl: "data:image/jpeg;base64,/9j/4AAQ",
      }),
  });

  const order = await client.createOrder("device-123", "pro_monthly");
  assert.equal(order.qrDataUrl, "data:image/jpeg;base64,/9j/4AAQ");
});

test("polls with the order capability in an Authorization header", async () => {
  let authorization = "";
  const client = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    fetchImpl: async (_url, init) => {
      authorization = String(
        new Headers(init?.headers).get("Authorization") || "",
      );
      return jsonResponse(200, {
        orderId: "order_123456",
        status: "paid",
        expiresAt: "2026-07-29T12:15:00.000Z",
        entitlementToken: "header123456.payload123456.signature1234567890",
      });
    },
  });

  const result = await client.pollOrder("order_123456", "poll_12345678");
  assert.equal(result.status, "paid");
  assert.equal(authorization, "Bearer poll_12345678");
});

test("rejects malformed QR data and surfaces only structured API errors", async () => {
  const malformed = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    fetchImpl: async () =>
      jsonResponse(201, {
        orderId: "order_123456",
        pollToken: "poll_12345678",
        status: "pending",
        planId: "pro_monthly",
        amountFen: 1990,
        expiresAt: "2026-07-29T12:15:00.000Z",
        qrDataUrl: "javascript:alert(1)",
      }),
  });
  await assert.rejects(
    () => malformed.createOrder("device-123", "pro_monthly"),
    /response/i,
  );

  const failed = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    fetchImpl: async () =>
      jsonResponse(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "授权服务暂时不可用，请稍后重试。",
          stack: "secret stack",
        },
      }),
  });
  await assert.rejects(
    () => failed.catalog(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "授权服务暂时不可用，请稍后重试。" &&
      !error.message.includes("stack"),
  );
});

test("times out a stalled licensing request", async () => {
  const client = new LicenseClient({
    baseUrl: "https://license.example.com",
    clientVersion: "0.1.0",
    requestTimeoutMs: 10,
    fetchImpl: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  await assert.rejects(() => client.catalog(), /超时/);
});
