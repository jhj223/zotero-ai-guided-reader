import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import QRCode from "qrcode";
import type { LicensingService, PaidPlanId } from "./domain.js";
import type { EntitlementSigner } from "./entitlements.js";
import type { ChinaumsQrProvider } from "./payments/chinaumsQr.js";
import type { ChinaumsWebhookProcessor } from "./payments/chinaumsWebhook.js";
import type { PaymentProvider } from "./payments/provider.js";
import type { SandboxPaymentProvider } from "./payments/sandbox.js";
import type { StaticQrBridge } from "./payments/staticQrBridge.js";
import type { WechatWebhookProcessor } from "./payments/wechatWebhook.js";
import { FixedWindowRateLimiter } from "./rateLimit.js";

const MAX_JSON_BYTES = 16 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;
const CHINAUMS_QUERY_RETENTION_MS = 20 * 60 * 1000;

export interface LicensingServerDependencies {
  licensing: LicensingService;
  signer: EntitlementSigner;
  paymentProvider: PaymentProvider;
  sandboxPaymentProvider?: SandboxPaymentProvider;
  staticQrBridge?: StaticQrBridge;
  webhookProcessor?: WechatWebhookProcessor;
  chinaumsPaymentProvider?: ChinaumsQrProvider;
  chinaumsWebhookProcessor?: ChinaumsWebhookProcessor;
  sourceUrl: string;
  now?: () => number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createLicensingServer(
  dependencies: LicensingServerDependencies,
) {
  if (
    dependencies.paymentProvider.kind === "wechat-static-qr" &&
    !dependencies.staticQrBridge
  ) {
    throw new Error("Static QR payments require a merchant receipt bridge.");
  }
  if (
    dependencies.paymentProvider.kind === "chinaums-qr" &&
    (dependencies.chinaumsPaymentProvider !== dependencies.paymentProvider ||
      !dependencies.chinaumsWebhookProcessor)
  ) {
    throw new Error(
      "ChinaUMS QR payments require the matching query provider and webhook processor.",
    );
  }
  const now = dependencies.now ?? Date.now;
  const processPepper = randomBytes(32);
  const chinaumsQueryTimes = new Map<string, number>();
  const chinaumsQueryCleanup = { nextAt: 0 };
  const limiters = {
    trialsBySource: new FixedWindowRateLimiter({
      limit: 20,
      windowMs: 60 * 60 * 1000,
      now,
    }),
    trialsByDevice: new FixedWindowRateLimiter({
      limit: 5,
      windowMs: 60 * 60 * 1000,
      now,
    }),
    ordersBySource: new FixedWindowRateLimiter({
      limit: 30,
      windowMs: 10 * 60 * 1000,
      now,
    }),
    ordersByDevice: new FixedWindowRateLimiter({
      limit: 10,
      windowMs: 10 * 60 * 1000,
      now,
    }),
    polls: new FixedWindowRateLimiter({
      limit: 120,
      windowMs: 5 * 60 * 1000,
      now,
    }),
    refreshes: new FixedWindowRateLimiter({
      limit: 30,
      windowMs: 5 * 60 * 1000,
      now,
    }),
    merchantRequests: new FixedWindowRateLimiter({
      limit: 300,
      windowMs: 5 * 60 * 1000,
      now,
    }),
  };

  return createServer((request, response) => {
    applySecurityHeaders(response);
    void handleRequest(request, response, dependencies, {
      now,
      processPepper,
      chinaumsQueryTimes,
      chinaumsQueryCleanup,
      limiters,
    }).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof ApiError) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      sendError(
        response,
        500,
        "INTERNAL_ERROR",
        "授权服务暂时不可用，请稍后重试。",
      );
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: LicensingServerDependencies,
  runtime: {
    now: () => number;
    processPepper: Buffer;
    chinaumsQueryTimes: Map<string, number>;
    chinaumsQueryCleanup: { nextAt: number };
    limiters: {
      trialsBySource: FixedWindowRateLimiter;
      trialsByDevice: FixedWindowRateLimiter;
      ordersBySource: FixedWindowRateLimiter;
      ordersByDevice: FixedWindowRateLimiter;
      polls: FixedWindowRateLimiter;
      refreshes: FixedWindowRateLimiter;
      merchantRequests: FixedWindowRateLimiter;
    };
  },
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://license.invalid");

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/about") {
    sendJson(response, 200, {
      name: "Zotero AI Guided Reader licensing service",
      license: "AGPL-3.0-or-later",
      sourceUrl: dependencies.sourceUrl,
    });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/catalog") {
    const paymentAvailability =
      dependencies.paymentProvider.kind === "wechat-static-qr"
        ? dependencies.staticQrBridge?.availability()
        : { available: true, reason: null };
    sendJson(response, 200, {
      trialDays: 7,
      plans: dependencies.licensing.catalog(),
      payment: {
        provider: dependencies.paymentProvider.kind,
        available: paymentAvailability?.available ?? false,
        reason: paymentAvailability
          ? paymentAvailability.reason
          : "PAYMENT_WATCHER_OFFLINE",
      },
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/trials") {
    const body = await readStrictJson(request, ["deviceId", "clientVersion"]);
    const deviceId = requireDeviceId(body.deviceId);
    requireClientVersion(body.clientVersion);
    enforceLimit(
      response,
      runtime.limiters.trialsBySource,
      requestSourceIdentity(request, runtime.processPepper),
    );
    enforceLimit(
      response,
      runtime.limiters.trialsByDevice,
      requestIdentity(request, deviceId, runtime.processPepper),
    );
    const existing = dependencies.licensing.getEntitlement(deviceId);
    if (existing?.kind === "pro") {
      throw new ApiError(
        409,
        "ENTITLEMENT_EXISTS",
        "该设备已有付费授权，请使用现有授权令牌刷新。",
      );
    }
    const entitlement = dependencies.licensing.startTrial(deviceId);
    sendJson(response, 201, {
      status: entitlement.kind,
      validUntil: new Date(entitlement.validUntil).toISOString(),
      entitlementToken: dependencies.signer.sign(entitlement, runtime.now()),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/orders") {
    const body = await readStrictJson(request, [
      "deviceId",
      "clientVersion",
      "planId",
    ]);
    const deviceId = requireDeviceId(body.deviceId);
    requireClientVersion(body.clientVersion);
    const planId = requirePlanId(body.planId);
    enforceLimit(
      response,
      runtime.limiters.ordersBySource,
      requestSourceIdentity(request, runtime.processPepper),
    );
    enforceLimit(
      response,
      runtime.limiters.ordersByDevice,
      requestIdentity(request, deviceId, runtime.processPepper),
    );
    if (dependencies.paymentProvider.kind === "wechat-static-qr") {
      const availability = dependencies.staticQrBridge?.availability();
      if (!availability?.available) {
        throw new ApiError(
          503,
          "PAYMENT_WATCHER_OFFLINE",
          "自动到账服务暂不可用，请稍后再试。",
        );
      }
    }
    const order = dependencies.licensing.createOrder(
      deviceId,
      planId,
      dependencies.paymentProvider.kind,
    );
    const payment = await dependencies.paymentProvider.createPayment({
      orderId: order.id,
      amountFen: order.amountFen,
      description:
        planId === "pro_monthly" ? "AI 带读 Pro 月付" : "AI 带读 Pro 年付",
      expiresAt: order.expiresAt,
    });
    if (dependencies.paymentProvider.kind === "chinaums-qr") {
      dependencies.licensing.bindProviderOrderId(
        order.id,
        payment.providerOrderId,
      );
    }
    const qrDataUrl =
      "qrDataUrl" in payment
        ? payment.qrDataUrl
        : await QRCode.toDataURL(validatePaymentCodeUrl(payment.codeUrl), {
            type: "image/png",
            errorCorrectionLevel: "M",
            margin: 2,
            width: 320,
            color: { dark: "#111827ff", light: "#ffffffff" },
          });
    sendJson(response, 201, {
      orderId: order.id,
      pollToken: order.pollToken,
      status: order.status,
      planId: order.planId,
      baseAmountFen: order.baseAmountFen,
      amountFen: order.amountFen,
      expiresAt: new Date(order.expiresAt).toISOString(),
      qrDataUrl,
    });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/v1/merchant/heartbeat" &&
    dependencies.staticQrBridge
  ) {
    enforceLimit(
      response,
      runtime.limiters.merchantRequests,
      requestSourceIdentity(request, runtime.processPepper),
    );
    const rawBody = await readJsonBody(request, MAX_JSON_BYTES);
    mapMerchantError(() =>
      dependencies.staticQrBridge?.processHeartbeat(
        new Headers(flattenHeaders(request)),
        rawBody,
      ),
    );
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/v1/merchant/receipts" &&
    dependencies.staticQrBridge
  ) {
    enforceLimit(
      response,
      runtime.limiters.merchantRequests,
      requestSourceIdentity(request, runtime.processPepper),
    );
    const rawBody = await readJsonBody(request, MAX_JSON_BYTES);
    const result = mapMerchantError(() =>
      dependencies.staticQrBridge?.processReceipt(
        new Headers(flattenHeaders(request)),
        rawBody,
      ),
    );
    if (!result) throw new Error("MERCHANT_RECEIPT_RESULT_MISSING");
    sendJson(response, 202, {
      accepted: true,
      status: result.status,
      replay: result.isReplay,
    });
    return;
  }

  const orderMatch = /^\/v1\/orders\/([A-Za-z0-9_-]{1,128})$/.exec(
    url.pathname,
  );
  if (method === "GET" && orderMatch) {
    const pollToken = bearerToken(request);
    enforceLimit(
      response,
      runtime.limiters.polls,
      requestIdentity(request, orderMatch[1], runtime.processPepper),
    );
    let order = dependencies.licensing.getOrder(orderMatch[1], pollToken);
    if (!order) {
      throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
    }
    if (
      order.status === "pending" &&
      order.provider === "chinaums-qr" &&
      order.providerOrderId &&
      dependencies.chinaumsPaymentProvider
    ) {
      const currentTime = runtime.now();
      if (currentTime >= runtime.chinaumsQueryCleanup.nextAt) {
        for (const [orderId, queriedAt] of runtime.chinaumsQueryTimes) {
          if (currentTime - queriedAt > CHINAUMS_QUERY_RETENTION_MS) {
            runtime.chinaumsQueryTimes.delete(orderId);
          }
        }
        runtime.chinaumsQueryCleanup.nextAt = currentTime + 60_000;
      }
      const lastQuery = runtime.chinaumsQueryTimes.get(order.id);
      if (lastQuery == null || currentTime - lastQuery >= 5_000) {
        runtime.chinaumsQueryTimes.set(order.id, currentTime);
        try {
          const payment =
            await dependencies.chinaumsPaymentProvider.queryPayment(
              order.providerOrderId,
            );
          if (payment.status === "paid") {
            dependencies.licensing.recordWebhookPayment(
              payment.eventId,
              currentTime,
              {
                orderId: order.id,
                transactionId: payment.transactionId,
                amountFen: payment.amountFen,
                paidAt: payment.paidAt,
              },
            );
          }
        } catch {
          // Fail closed: a provider or network error must never activate access.
        }
        order = dependencies.licensing.getOrder(orderMatch[1], pollToken);
        if (!order) throw new Error("ORDER_DISAPPEARED_AFTER_PAYMENT_QUERY");
        if (order.status !== "pending") {
          runtime.chinaumsQueryTimes.delete(order.id);
        }
      }
    }
    const base = {
      orderId: order.id,
      status: order.status,
      expiresAt: new Date(order.expiresAt).toISOString(),
    };
    if (order.status !== "paid") {
      sendJson(response, 200, base);
      return;
    }
    const entitlement = dependencies.licensing.getEntitlement(order.deviceId);
    if (!entitlement) {
      throw new Error("PAID_ORDER_WITHOUT_ENTITLEMENT");
    }
    sendJson(response, 200, {
      ...base,
      entitlementToken: dependencies.signer.sign(entitlement, runtime.now()),
    });
    return;
  }

  const sandboxMatch = /^\/v1\/sandbox\/pay\/([A-Za-z0-9_-]{1,128})$/.exec(
    url.pathname,
  );
  if (sandboxMatch && dependencies.sandboxPaymentProvider) {
    const orderId = sandboxMatch[1];
    if (method === "GET") {
      const proof = url.searchParams.get("proof") || "";
      if (!dependencies.sandboxPaymentProvider.verifyProof(orderId, proof)) {
        throw new ApiError(404, "NOT_FOUND", "测试订单不存在。");
      }
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      sendHtml(
        response,
        200,
        `<!doctype html><meta charset="utf-8"><title>测试付款</title>` +
          `<h1>AI 带读测试付款</h1>` +
          `<p>这是沙盒环境，不会产生真实扣款。</p>` +
          `<form method="post">` +
          `<input type="hidden" name="proof" value="${proof}">` +
          `<button type="submit">确认测试付款</button></form>`,
      );
      return;
    }
    if (method === "POST") {
      const mediaType = String(request.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (mediaType !== "application/x-www-form-urlencoded") {
        throw new ApiError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "测试付款表单格式无效。",
        );
      }
      const form = new URLSearchParams(await readRawBody(request, 2_048));
      const proof = form.get("proof") || "";
      if (!dependencies.sandboxPaymentProvider.verifyProof(orderId, proof)) {
        throw new ApiError(404, "NOT_FOUND", "测试订单不存在。");
      }
      const transactionId = `sandbox_tx_${createHash("sha256")
        .update(orderId)
        .update("\0")
        .update(proof)
        .digest("base64url")
        .slice(0, 32)}`;
      dependencies.licensing.completeSandboxPayment(
        orderId,
        transactionId,
        runtime.now(),
      );
      sendHtml(
        response,
        200,
        '<!doctype html><meta charset="utf-8"><title>测试付款成功</title><h1>测试付款成功</h1><p>请返回 Zotero，授权会自动刷新。</p>',
      );
      return;
    }
  }

  if (method === "POST" && url.pathname === "/v1/entitlements/refresh") {
    const body = await readStrictJson(request, [
      "deviceId",
      "clientVersion",
      "entitlementToken",
    ]);
    const deviceId = requireDeviceId(body.deviceId);
    requireClientVersion(body.clientVersion);
    if (
      typeof body.entitlementToken !== "string" ||
      body.entitlementToken.length < 32 ||
      body.entitlementToken.length > 8_192
    ) {
      throw new ApiError(422, "VALIDATION_ERROR", "授权令牌无效。");
    }
    enforceLimit(
      response,
      runtime.limiters.refreshes,
      requestIdentity(request, deviceId, runtime.processPepper),
    );
    let claims;
    try {
      claims = dependencies.signer.verify(body.entitlementToken);
    } catch {
      throw new ApiError(401, "ENTITLEMENT_INVALID", "授权令牌无效。");
    }
    if (claims.deviceId !== deviceId) {
      throw new ApiError(401, "ENTITLEMENT_INVALID", "授权令牌无效。");
    }
    const currentTime = runtime.now();
    if (
      claims.validUntil <= currentTime ||
      claims.issuedAt > currentTime + 5 * 60 * 1000
    ) {
      throw new ApiError(401, "ENTITLEMENT_INVALID", "授权令牌无效。");
    }
    const entitlement = dependencies.licensing.getEntitlement(deviceId);
    if (!entitlement || entitlement.validUntil <= currentTime) {
      throw new ApiError(403, "ENTITLEMENT_EXPIRED", "授权已到期。");
    }
    sendJson(response, 200, {
      status: entitlement.kind,
      validUntil: new Date(entitlement.validUntil).toISOString(),
      entitlementToken: dependencies.signer.sign(entitlement, runtime.now()),
    });
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/v1/webhooks/chinaums" &&
    dependencies.paymentProvider.kind === "chinaums-qr" &&
    dependencies.chinaumsWebhookProcessor
  ) {
    enforceLimit(
      response,
      runtime.limiters.merchantRequests,
      requestSourceIdentity(request, runtime.processPepper),
    );
    try {
      const mediaType = String(request.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (mediaType !== "application/x-www-form-urlencoded") {
        throw new Error("CHINAUMS_CALLBACK_MEDIA_TYPE_INVALID");
      }
      const rawBody = await readRawBody(request, 64 * 1024);
      dependencies.chinaumsWebhookProcessor.process(rawBody);
      sendText(response, 200, "SUCCESS");
    } catch {
      if (!response.headersSent) sendText(response, 400, "FAILED");
    }
    return;
  }

  if (
    method === "POST" &&
    url.pathname === "/v1/webhooks/wechat" &&
    dependencies.webhookProcessor
  ) {
    const rawBody = await readRawBody(request, 64 * 1024);
    dependencies.webhookProcessor.process(
      new Headers(flattenHeaders(request)),
      rawBody,
    );
    sendJson(response, 200, { code: "SUCCESS", message: "成功" });
    return;
  }

  throw new ApiError(404, "NOT_FOUND", "接口不存在。");
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

async function readStrictJson(
  request: IncomingMessage,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown>> {
  const mediaType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 application/json。",
    );
  }
  const rawBody = await readRawBody(request, MAX_JSON_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求 JSON 格式无效。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "请求内容无效。");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ApiError(422, "VALIDATION_ERROR", "请求包含不允许的字段。");
  }
  return body;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const mediaType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 application/json。",
    );
  }
  return readRawBody(request, maxBytes);
}

async function readRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过大。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new ApiError(413, "BODY_TOO_LARGE", "请求内容过大。");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "设备标识无效。");
  }
  return value;
}

function requireClientVersion(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_VERSION_PATTERN.test(value)) {
    throw new ApiError(422, "VALIDATION_ERROR", "客户端版本无效。");
  }
  return value;
}

function requirePlanId(value: unknown): PaidPlanId {
  if (value !== "pro_monthly" && value !== "pro_yearly") {
    throw new ApiError(422, "VALIDATION_ERROR", "付费套餐无效。");
  }
  return value;
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  const match = /^Bearer ([A-Za-z0-9_-]{8,256})$/.exec(value || "");
  if (!match) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
  }
  return match[1];
}

function requestIdentity(
  request: IncomingMessage,
  scope: string,
  pepper: Buffer,
): string {
  return createHash("sha256")
    .update(pepper)
    .update("\0")
    .update(request.socket.remoteAddress || "unknown")
    .update("\0")
    .update(scope)
    .digest("base64url");
}

function requestSourceIdentity(
  request: IncomingMessage,
  pepper: Buffer,
): string {
  return createHash("sha256")
    .update(pepper)
    .update("\0")
    .update(requestSourceAddress(request))
    .digest("base64url");
}

function requestSourceAddress(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress || "unknown";
  const directIsLoopback =
    direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
  const forwarded = request.headers["x-real-ip"];
  if (
    directIsLoopback &&
    typeof forwarded === "string" &&
    isIP(forwarded.trim()) !== 0
  ) {
    return forwarded.trim();
  }
  return direct;
}

function enforceLimit(
  response: ServerResponse,
  limiter: FixedWindowRateLimiter,
  key: string,
): void {
  const decision = limiter.consume(key);
  response.setHeader("X-RateLimit-Remaining", decision.remaining);
  if (!decision.allowed) {
    response.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
    );
    throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。");
  }
}

function validatePaymentCodeUrl(value: string): string {
  if (value.startsWith("weixin://wxpay/")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PAYMENT_PROVIDER_INVALID_CODE_URL");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("PAYMENT_PROVIDER_INVALID_CODE_URL");
  }
  return url.toString();
}

function mapMerchantError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "MERCHANT_SIGNATURE_INVALID") {
      throw new ApiError(401, "MERCHANT_AUTH_INVALID", "商户监听器认证失败。");
    }
    if (
      code === "RECEIPT_NONCE_REPLAY" ||
      code === "RECEIPT_EVENT_REPLAY_MISMATCH"
    ) {
      throw new ApiError(409, "MERCHANT_EVENT_REPLAYED", "收款事件已处理。");
    }
    if (
      code === "INVALID_HEARTBEAT_EVENT" ||
      code === "INVALID_RECEIPT_EVENT" ||
      code === "INVALID_MERCHANT_JSON" ||
      code === "INVALID_MERCHANT_EVENT_FIELDS"
    ) {
      throw new ApiError(422, "MERCHANT_EVENT_INVALID", "收款事件无效。");
    }
    throw error;
  }
}

function flattenHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.end(encoded);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { error: { code, message } });
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}
