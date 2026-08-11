import { Hono, type Context } from "hono";
import {
  afdianConfig,
  assertAfdianOrderMatches,
  buildAfdianCheckoutUrl,
  parseAfdianWebhook,
  queryAfdianOrder,
  queryRecentAfdianOrders,
} from "./afdian";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
  type WorkerEnv,
} from "./config";
import { hashText, signEntitlement, verifyRefreshToken } from "./crypto";
import { LicensingService } from "./service";
import { LicensingStore, type PaidPlanId } from "./store";

const MAX_JSON_BYTES = 16 * 1024;
const CLIENT_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ORDER_ID = /^ord_[A-Za-z0-9_-]{20,128}$/;
const POLL_TOKEN = /^poll_[A-Za-z0-9_-]{20,128}$/;
const REFRESH_CREDENTIAL_GRACE_MS = 90 * 86_400_000;

type AppBindings = { Bindings: WorkerEnv };
type WorkerFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface AppOptions {
  now?: () => number;
  fetcher?: WorkerFetch;
}

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createWorkerApp(options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const app = new Hono<AppBindings>();

  app.use("*", async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
    context.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    context.header("referrer-policy", "no-referrer");
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
  });

  app.get("/healthz", (context) => context.json({ status: "ok" }));

  app.get("/v1/about", (context) => {
    const config = loadRuntimeConfig(context.env);
    return context.json({
      name: "Zotero AI Guided Reader licensing service",
      license: "AGPL-3.0-or-later",
      sourceUrl: config.sourceUrl,
    });
  });

  app.get("/v1/catalog", (context) => {
    const { service } = runtime(context.env, now);
    return context.json({
      trialDays: 7,
      plans: service.catalog(),
      payment: { provider: "afdian", available: true, reason: null },
    });
  });

  app.post("/v1/trials", async (context) => {
    const body = await strictJson(context, ["deviceId", "clientVersion"]);
    const deviceId = requireDeviceId(body.deviceId);
    requireClientVersion(body.clientVersion);
    const state = runtime(context.env, now);
    await enforceLimit(
      state,
      context,
      "trial-source",
      sourceIdentity(context),
      3,
      24 * 3_600_000,
    );
    await enforceLimit(
      state,
      context,
      "trial-device",
      deviceId,
      3,
      24 * 3_600_000,
    );
    const existing = await state.store.getEntitlement(deviceId);
    if (existing?.kind === "pro") {
      throw new ApiError(409, "ENTITLEMENT_EXISTS", "该设备已有付费授权。");
    }
    const entitlement = await state.service.startTrial(deviceId);
    return context.json(await issue(entitlement, state.config, now()), 201);
  });

  app.post("/v1/orders", async (context) => {
    const body = await strictJson(context, [
      "deviceId",
      "clientVersion",
      "planId",
    ]);
    const deviceId = requireDeviceId(body.deviceId);
    requireClientVersion(body.clientVersion);
    const planId = requirePlanId(body.planId);
    const state = runtime(context.env, now);
    await enforceLimit(
      state,
      context,
      "order-source",
      sourceIdentity(context),
      30,
      600_000,
    );
    await enforceLimit(state, context, "order-device", deviceId, 10, 600_000);
    const order = await state.service.createOrder(deviceId, planId);
    const providerPlanId =
      planId === "pro_monthly"
        ? state.config.afdian.monthlyPlanId
        : state.config.afdian.yearlyPlanId;
    return context.json(
      {
        orderId: order.orderId,
        pollToken: order.pollToken,
        status: order.status,
        planId: order.planId,
        amountFen: order.amountFen,
        expiresAt: new Date(order.expiresAt).toISOString(),
        checkoutUrl: buildAfdianCheckoutUrl(
          providerPlanId,
          order.customOrderId,
        ),
      },
      201,
    );
  });

  app.get("/v1/orders/:orderId", async (context) => {
    const orderId = context.req.param("orderId");
    if (!ORDER_ID.test(orderId)) {
      throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
    }
    const pollToken = bearerToken(context);
    const state = runtime(context.env, now);
    await enforceLimit(
      state,
      context,
      "poll-source",
      sourceIdentity(context),
      600,
      300_000,
    );
    await enforceLimit(state, context, "poll-order", orderId, 120, 300_000);
    let order = await state.service.pollOrder(orderId, pollToken);
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
    if (order.status === "pending" && order.expiresAt < now()) {
      await state.store.expireOrder(order.id, now());
      order = await state.service.pollOrder(orderId, pollToken);
      if (!order) throw new Error("ORDER_STATE_UNAVAILABLE");
    }
    const response: Record<string, unknown> = {
      orderId: order.id,
      status: order.status,
      expiresAt: new Date(order.expiresAt).toISOString(),
    };
    if (order.status === "paid") {
      const entitlement = await state.store.getEntitlement(order.deviceId);
      if (!entitlement) throw new Error("PAID_ORDER_WITHOUT_ENTITLEMENT");
      response.entitlementToken = await signEntitlement(
        entitlement,
        now(),
        signingConfig(state.config),
      );
    }
    return context.json(response);
  });

  app.post("/v1/entitlements/refresh", async (context) => {
    const body = await strictJson(context, [
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
      throw new ApiError(400, "INVALID_ENTITLEMENT", "授权令牌无效。");
    }
    const state = runtime(context.env, now);
    await enforceLimit(state, context, "refresh-device", deviceId, 30, 300_000);
    let claims;
    try {
      claims = verifyRefreshToken(
        body.entitlementToken,
        deviceId,
        signingConfig(state.config),
      );
    } catch {
      throw new ApiError(401, "INVALID_ENTITLEMENT", "授权令牌无效。");
    }
    const currentTime = now();
    if (
      claims.validUntil < currentTime - REFRESH_CREDENTIAL_GRACE_MS ||
      claims.issuedAt > currentTime + 5 * 60 * 1000
    ) {
      throw new ApiError(401, "INVALID_ENTITLEMENT", "授权令牌无效。");
    }
    const entitlement = await state.store.getEntitlement(deviceId);
    if (!entitlement) {
      throw new ApiError(404, "ENTITLEMENT_NOT_FOUND", "未找到授权。");
    }
    if (entitlement.validUntil <= currentTime) {
      throw new ApiError(403, "ENTITLEMENT_EXPIRED", "授权已到期。");
    }
    return context.json(await issue(entitlement, state.config, currentTime));
  });

  app.post("/v1/webhooks/afdian", async (context) => {
    const payload = await jsonBody(context);
    let webhook;
    try {
      webhook = parseAfdianWebhook(payload);
    } catch {
      throw new ApiError(400, "INVALID_WEBHOOK", "付款通知格式无效。");
    }
    const state = runtime(context.env, now);
    await enforceLimit(
      state,
      context,
      "webhook-source",
      sourceIdentity(context),
      300,
      300_000,
    );
    const order = await state.store.findOrderByCustomOrderId(
      webhook.customOrderId,
    );
    if (!order) return context.json({ ec: 200, em: "" });
    let queried;
    try {
      queried = await queryAfdianOrder(
        webhook.outTradeNo,
        afdianConfig(state.config),
        { fetcher, now },
      );
    } catch {
      throw new ApiError(
        502,
        "PAYMENT_VERIFICATION_FAILED",
        "付款暂时无法核验。",
      );
    }
    if (!queried) {
      throw new ApiError(
        502,
        "PAYMENT_VERIFICATION_FAILED",
        "付款暂时无法核验。",
      );
    }
    let verified;
    try {
      verified = assertAfdianOrderMatches(
        order,
        queried,
        afdianConfig(state.config),
      );
    } catch {
      throw new ApiError(401, "PAYMENT_MISMATCH", "付款信息与订单不一致。");
    }
    try {
      await state.store.completePayment({
        orderId: order.id,
        ...verified,
        receivedAt: now(),
        verifiedAt: now(),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "PAYMENT_REPLAY_MISMATCH",
          "PAYMENT_AMOUNT_MISMATCH",
          "ORDER_NOT_PENDING",
          "ORDER_PAYMENT_EXPIRED",
        ].includes(error.message)
      ) {
        throw new ApiError(401, "PAYMENT_MISMATCH", "付款信息与订单不一致。");
      }
      throw error;
    }
    return context.json({ ec: 200, em: "" });
  });

  for (const path of [
    "/healthz",
    "/v1/about",
    "/v1/catalog",
    "/v1/trials",
    "/v1/orders",
    "/v1/entitlements/refresh",
    "/v1/webhooks/afdian",
  ]) {
    app.all(path, () => {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "请求方法不受支持。");
    });
  }
  app.all("/v1/orders/:orderId", () => {
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "请求方法不受支持。");
  });

  app.notFound((context) =>
    context.json(
      { error: { code: "NOT_FOUND", message: "接口不存在。" } },
      404,
    ),
  );
  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return context.json(
      { error: { code: "INTERNAL_ERROR", message: "授权服务暂时不可用。" } },
      500,
    );
  });
  return app;
}

export async function reconcilePendingOrders(
  env: WorkerEnv,
  options: { now?: () => number; fetcher?: WorkerFetch } = {},
): Promise<{ checked: number; completed: number }> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const state = runtime(env, now);
  const currentTime = now();
  let checked = 0;
  let completed = 0;
  try {
    const candidates = await state.store.listReconcilableOrders(
      currentTime - 7 * 86_400_000,
      300,
    );
    const byCustomOrder = new Map(
      candidates.map((order) => [order.customOrderId, order]),
    );
    const oldestCandidate = Math.min(
      ...candidates.map((order) => order.createdAt),
    );
    for (let page = 1; page <= 20 && byCustomOrder.size > 0; page += 1) {
      const providerPage = await queryRecentAfdianOrders(
        afdianConfig(state.config),
        { page, fetcher, now },
      );
      for (const providerOrder of providerPage.orders) {
        const localOrder = byCustomOrder.get(providerOrder.customOrderId);
        if (!localOrder) continue;
        checked += 1;
        byCustomOrder.delete(providerOrder.customOrderId);
        try {
          const verified = assertAfdianOrderMatches(
            localOrder,
            providerOrder,
            afdianConfig(state.config),
          );
          const result = await state.store.completePayment({
            orderId: localOrder.id,
            ...verified,
            receivedAt: now(),
            verifiedAt: now(),
          });
          if (!result.isReplay) completed += 1;
        } catch {
          // A mismatched provider record never grants access.
        }
      }
      if (page >= providerPage.totalPage || providerPage.orders.length === 0) {
        break;
      }
      const oldestSeen = Math.min(
        ...providerPage.orders.map((order) => order.createTime * 1000),
      );
      if (oldestSeen < oldestCandidate) break;
    }
  } finally {
    const cleanupTime = now();
    await state.store.expirePendingOrders(cleanupTime);
    await state.store.deleteExpiredRateLimits(cleanupTime);
    await state.store.pruneExpiredOrderArtifacts(
      cleanupTime - 30 * 86_400_000,
      500,
    );
  }
  return { checked, completed };
}

const productionApp = createWorkerApp();

export default {
  fetch: (request, env, context) => productionApp.fetch(request, env, context),
  scheduled: (_controller, env, context) => {
    context.waitUntil(
      reconcilePendingOrders(env).catch((error) => {
        console.error(
          "Afdian reconciliation failed:",
          error instanceof Error ? error.message : "unknown",
        );
      }),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;

function runtime(env: WorkerEnv, now: () => number) {
  const config = loadRuntimeConfig(env);
  const store = new LicensingStore(env.DB);
  return { config, store, service: new LicensingService(store, now), now };
}

function signingConfig(config: RuntimeConfig) {
  return {
    issuer: config.issuer,
    audience: config.audience,
    keyId: config.keyId,
    privateKeyPem: config.privateKeyPem,
    verificationKeys: config.previousPublicKeys,
  };
}

async function issue(
  entitlement: Awaited<ReturnType<LicensingStore["getEntitlement"]>> & {},
  config: RuntimeConfig,
  issuedAt: number,
) {
  return {
    status: entitlement.kind,
    validUntil: new Date(entitlement.validUntil).toISOString(),
    entitlementToken: await signEntitlement(
      entitlement,
      issuedAt,
      signingConfig(config),
    ),
  };
}

async function strictJson(
  context: Context<AppBindings>,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown>> {
  const value = await jsonBody(context);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "请求内容无效。");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new ApiError(400, "INVALID_REQUEST", "请求包含未知字段。");
  }
  return body;
}

async function jsonBody(context: Context<AppBindings>): Promise<unknown> {
  const contentType = context.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JSON 请求。");
  }
  const declaredLength = Number(context.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "请求内容过大。");
  }
  const text = await context.req.text();
  if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "请求内容过大。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "JSON 内容无效。");
  }
}

function requireDeviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "设备标识无效。");
  }
  return value;
}

function requireClientVersion(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_VERSION.test(value)) {
    throw new ApiError(400, "INVALID_CLIENT_VERSION", "客户端版本无效。");
  }
  return value;
}

function requirePlanId(value: unknown): PaidPlanId {
  if (value !== "pro_monthly" && value !== "pro_yearly") {
    throw new ApiError(400, "INVALID_PLAN", "套餐无效。");
  }
  return value;
}

function bearerToken(context: Context<AppBindings>): string {
  const match = context.req
    .header("authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match || !POLL_TOKEN.test(match[1])) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "订单不存在。");
  }
  return match[1];
}

function sourceIdentity(context: Context<AppBindings>): string {
  const value = context.req.header("cf-connecting-ip") ?? "unknown";
  return value.slice(0, 128);
}

async function enforceLimit(
  state: ReturnType<typeof runtime>,
  context: Context<AppBindings>,
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const keyHash = await hashText(
    `${state.config.rateLimitPepper}\0${scope}\0${identity}`,
  );
  const allowed = await state.store.consumeRateLimit({
    keyHash,
    now: state.now(),
    windowMs,
    limit,
  });
  if (!allowed) {
    context.header("retry-after", String(Math.ceil(windowMs / 1000)));
    throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。");
  }
}
