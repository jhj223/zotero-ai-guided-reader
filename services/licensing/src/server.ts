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
import type { PaymentProvider } from "./payments/provider.js";
import type { SandboxPaymentProvider } from "./payments/sandbox.js";
import type { WechatWebhookProcessor } from "./payments/wechatWebhook.js";
import { FixedWindowRateLimiter } from "./rateLimit.js";

const MAX_JSON_BYTES = 16 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;

export interface LicensingServerDependencies {
  licensing: LicensingService;
  signer: EntitlementSigner;
  paymentProvider: PaymentProvider;
  sandboxPaymentProvider?: SandboxPaymentProvider;
  webhookProcessor?: WechatWebhookProcessor;
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
  const now = dependencies.now ?? Date.now;
  const processPepper = randomBytes(32);
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
  };

  return createServer((request, response) => {
    applySecurityHeaders(response);
    void handleRequest(request, response, dependencies, {
      now,
      processPepper,
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
    limiters: {
      trialsBySource: FixedWindowRateLimiter;
      trialsByDevice: FixedWindowRateLimiter;
      ordersBySource: FixedWindowRateLimiter;
      ordersByDevice: FixedWindowRateLimiter;
      polls: FixedWindowRateLimiter;
      refreshes: FixedWindowRateLimiter;
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
    sendJson(response, 200, {
      trialDays: 7,
      plans: dependencies.licensing.catalog(),
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
    const order = dependencies.licensing.createOrder(deviceId, planId);
    const payment = await dependencies.paymentProvider.createPayment({
      orderId: order.id,
      amountFen: order.amountFen,
      description:
        planId === "pro_monthly" ? "AI 带读 Pro 月付" : "AI 带读 Pro 年付",
      expiresAt: order.expiresAt,
    });
    const safeCodeUrl = validatePaymentCodeUrl(payment.codeUrl);
    const qrDataUrl = await QRCode.toDataURL(safeCodeUrl, {
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
      amountFen: order.amountFen,
      expiresAt: new Date(order.expiresAt).toISOString(),
      qrDataUrl,
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
    const order = dependencies.licensing.getOrder(orderMatch[1], pollToken);
    if (!order) {
      throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
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
