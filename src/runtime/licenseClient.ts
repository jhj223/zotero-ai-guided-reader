import type { LicensePlanId } from "../core/license";

export type PaidPlanId = Exclude<LicensePlanId, "trial">;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CHECKOUT_URL_LENGTH = 2_048;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const AFDIAN_CHECKOUT_HOSTS = new Set([
  "afdian.com",
  "www.afdian.com",
  "ifdian.net",
  "www.ifdian.net",
]);
const AFDIAN_PLAN_ID_PATTERN = /^[a-f0-9]{32}$/;
const CUSTOM_ORDER_ID_PATTERN = /^co_[A-Za-z0-9_-]{20,128}$/;

export type LicenseFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface LicensePlan {
  id: PaidPlanId;
  label: string;
  durationDays: 30 | 365;
  priceFen: number;
}

export interface LicenseCatalog {
  trialDays: number;
  plans: LicensePlan[];
}

export interface LicenseOrder {
  orderId: string;
  pollToken: string;
  status: "pending";
  planId: PaidPlanId;
  amountFen: number;
  expiresAt: string;
  qrDataUrl?: string;
  checkoutUrl?: string;
}

export interface PolledLicenseOrder {
  orderId: string;
  status: "pending" | "paid" | "expired" | "closed";
  expiresAt: string;
  entitlementToken?: string;
}

export interface IssuedEntitlement {
  status: "trial" | "pro";
  validUntil: string;
  entitlementToken: string;
}

export class LicenseApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LicenseApiError";
  }
}

export class LicenseClient {
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly fetchImpl: LicenseFetch;
  private readonly requestTimeoutMs: number;

  constructor(config: {
    baseUrl: string;
    clientVersion: string;
    allowLoopbackHttp?: boolean;
    fetchImpl?: LicenseFetch;
    requestTimeoutMs?: number;
  }) {
    this.baseUrl = validateBaseUrl(
      config.baseUrl,
      Boolean(config.allowLoopbackHttp),
    );
    if (!/^[0-9A-Za-z.+_-]{1,64}$/.test(config.clientVersion)) {
      throw new Error("License client version is invalid.");
    }
    this.clientVersion = config.clientVersion;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      this.requestTimeoutMs > 60_000
    ) {
      throw new Error("License request timeout is invalid.");
    }
  }

  async catalog(signal?: AbortSignal): Promise<LicenseCatalog> {
    return validateCatalog(
      await this.request("/v1/catalog", { method: "GET", signal }),
    );
  }

  async startTrial(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<IssuedEntitlement> {
    requireId(deviceId, "device");
    return validateIssuedEntitlement(
      await this.request("/v1/trials", {
        method: "POST",
        signal,
        body: JSON.stringify({
          deviceId,
          clientVersion: this.clientVersion,
        }),
      }),
    );
  }

  async createOrder(
    deviceId: string,
    planId: PaidPlanId,
    signal?: AbortSignal,
  ): Promise<LicenseOrder> {
    requireId(deviceId, "device");
    if (planId !== "pro_monthly" && planId !== "pro_yearly") {
      throw new Error("License plan is invalid.");
    }
    return validateOrder(
      await this.request("/v1/orders", {
        method: "POST",
        signal,
        body: JSON.stringify({
          deviceId,
          clientVersion: this.clientVersion,
          planId,
        }),
      }),
    );
  }

  async pollOrder(
    orderId: string,
    pollToken: string,
    signal?: AbortSignal,
  ): Promise<PolledLicenseOrder> {
    requireId(orderId, "order");
    if (!TOKEN_PATTERN.test(pollToken)) {
      throw new Error("Order polling token is invalid.");
    }
    return validatePolledOrder(
      await this.request(`/v1/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        signal,
        headers: { Authorization: `Bearer ${pollToken}` },
      }),
    );
  }

  async refresh(
    deviceId: string,
    entitlementToken: string,
    signal?: AbortSignal,
  ): Promise<IssuedEntitlement> {
    requireId(deviceId, "device");
    if (entitlementToken.length < 32 || entitlementToken.length > 8_192) {
      throw new Error("Entitlement token is invalid.");
    }
    return validateIssuedEntitlement(
      await this.request("/v1/entitlements/refresh", {
        method: "POST",
        signal,
        body: JSON.stringify({
          deviceId,
          clientVersion: this.clientVersion,
          entitlementToken,
        }),
      }),
    );
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...((init.headers || {}) as Record<string, string>),
    };
    if (init.body != null) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else
      callerSignal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("License service response is too large.");
      }
      text = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new Error("授权服务请求超时，请稍后重试。", {
          cause: error,
        });
      }
      if (callerSignal?.aborted) throw error;
      if (
        error instanceof Error &&
        error.message === "License service response is too large."
      ) {
        throw error;
      }
      throw new Error("无法连接授权服务，请检查网络后重试。", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
      throw new Error("License service response is too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error("License service returned an invalid response.", {
        cause: error,
      });
    }
    if (!response.ok) {
      const structured = parseStructuredError(body);
      throw new LicenseApiError(
        response.status,
        structured.code,
        structured.message,
      );
    }
    return body;
  }
}

function validateBaseUrl(value: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("License server URL is invalid.");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (
    url.protocol !== "https:" &&
    !(allowLoopbackHttp && loopback && url.protocol === "http:")
  ) {
    throw new Error("License server URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("License server URL is invalid.");
  }
  return url.toString().replace(/\/$/, "");
}

function validateCatalog(value: unknown): LicenseCatalog {
  const object = requireObject(value);
  if (
    !Number.isSafeInteger(object.trialDays) ||
    Number(object.trialDays) <= 0 ||
    !Array.isArray(object.plans)
  ) {
    throw invalidResponse();
  }
  return {
    trialDays: Number(object.trialDays),
    plans: object.plans.map(validatePlan),
  };
}

function validatePlan(value: unknown): LicensePlan {
  const object = requireObject(value);
  const id: PaidPlanId =
    object.id === "pro_monthly"
      ? "pro_monthly"
      : object.id === "pro_yearly"
        ? "pro_yearly"
        : (() => {
            throw invalidResponse();
          })();
  const expectedDuration = id === "pro_monthly" ? 30 : 365;
  if (
    typeof object.label !== "string" ||
    object.label.length === 0 ||
    object.label.length > 64 ||
    object.durationDays !== expectedDuration ||
    !Number.isSafeInteger(object.priceFen) ||
    Number(object.priceFen) <= 0
  ) {
    throw invalidResponse();
  }
  return {
    id,
    label: object.label,
    durationDays: expectedDuration,
    priceFen: Number(object.priceFen),
  };
}

function validateOrder(value: unknown): LicenseOrder {
  const object = requireObject(value);
  if (
    typeof object.orderId !== "string" ||
    !ID_PATTERN.test(object.orderId) ||
    typeof object.pollToken !== "string" ||
    !TOKEN_PATTERN.test(object.pollToken) ||
    object.status !== "pending" ||
    (object.planId !== "pro_monthly" && object.planId !== "pro_yearly") ||
    !Number.isSafeInteger(object.amountFen) ||
    Number(object.amountFen) <= 0 ||
    !validIsoDate(object.expiresAt)
  ) {
    throw invalidResponse();
  }

  const hasQr = object.qrDataUrl !== undefined;
  const hasCheckout = object.checkoutUrl !== undefined;
  if (hasQr === hasCheckout) throw invalidResponse();

  if (
    hasQr &&
    (typeof object.qrDataUrl !== "string" ||
      object.qrDataUrl.length > MAX_RESPONSE_BYTES ||
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        object.qrDataUrl,
      ))
  ) {
    throw invalidResponse();
  }
  if (hasCheckout) {
    if (typeof object.checkoutUrl !== "string") throw invalidResponse();
    try {
      validateAfdianCheckoutUrl(object.checkoutUrl);
    } catch {
      throw invalidResponse();
    }
  }

  return object as unknown as LicenseOrder;
}

export function validateAfdianCheckoutUrl(value: string): string {
  if (value.length === 0 || value.length > MAX_CHECKOUT_URL_LENGTH) {
    throw invalidCheckout();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidCheckout();
  }
  if (
    url.protocol !== "https:" ||
    !AFDIAN_CHECKOUT_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/order/create" ||
    url.hash
  ) {
    throw invalidCheckout();
  }

  const expectedKeys = new Set(["plan_id", "product_type", "custom_order_id"]);
  const seenKeys = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!expectedKeys.has(key) || seenKeys.has(key)) throw invalidCheckout();
    seenKeys.add(key);
  }
  if (
    seenKeys.size !== expectedKeys.size ||
    !AFDIAN_PLAN_ID_PATTERN.test(url.searchParams.get("plan_id") ?? "") ||
    url.searchParams.get("product_type") !== "0" ||
    !CUSTOM_ORDER_ID_PATTERN.test(url.searchParams.get("custom_order_id") ?? "")
  ) {
    throw invalidCheckout();
  }
  return value;
}

function invalidCheckout(): Error {
  return new Error("Afdian checkout URL is invalid.");
}

function validatePolledOrder(value: unknown): PolledLicenseOrder {
  const object = requireObject(value);
  if (
    typeof object.orderId !== "string" ||
    !ID_PATTERN.test(object.orderId) ||
    !["pending", "paid", "expired", "closed"].includes(String(object.status)) ||
    !validIsoDate(object.expiresAt) ||
    (object.status === "paid" &&
      (typeof object.entitlementToken !== "string" ||
        object.entitlementToken.length < 32 ||
        object.entitlementToken.length > 8_192))
  ) {
    throw invalidResponse();
  }
  return object as unknown as PolledLicenseOrder;
}

function validateIssuedEntitlement(value: unknown): IssuedEntitlement {
  const object = requireObject(value);
  if (
    (object.status !== "trial" && object.status !== "pro") ||
    !validIsoDate(object.validUntil) ||
    typeof object.entitlementToken !== "string" ||
    object.entitlementToken.length < 32 ||
    object.entitlementToken.length > 8_192
  ) {
    throw invalidResponse();
  }
  return object as unknown as IssuedEntitlement;
}

function parseStructuredError(value: unknown): {
  code: string;
  message: string;
} {
  const object = requireObject(value);
  const error = requireObject(object.error);
  if (
    typeof error.code !== "string" ||
    !/^[A-Z0-9_]{1,64}$/.test(error.code) ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > 256
  ) {
    return {
      code: "UNEXPECTED_ERROR",
      message: "授权服务返回了无法识别的错误。",
    };
  }
  return { code: error.code, message: error.message };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function requireId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} identifier is invalid.`);
  }
}

function validIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function invalidResponse(): Error {
  return new Error("License service returned an invalid response.");
}
