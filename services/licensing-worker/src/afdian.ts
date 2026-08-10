import { createHash } from "node:crypto";
import type { RuntimeConfig } from "./config";
import type { StoredOrder } from "./store";

const CHECKOUT_ORIGIN = "https://ifdian.net";
const QUERY_ORDER_URL = "https://ifdian.net/api/open/query-order";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const AFDIAN_ID = /^[0-9a-f]{32}$/;
const OUT_TRADE_NO = /^[A-Za-z0-9_-]{8,64}$/;
const CUSTOM_ORDER_ID = /^co_[A-Za-z0-9_-]{20,128}$/;

export const AFDIAN_WEBHOOK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----`;

export interface AfdianConfig {
  userId: string;
  apiToken: string;
  monthlyPlanId: string;
  yearlyPlanId: string;
}

export interface AfdianOrder {
  outTradeNo: string;
  customOrderId: string;
  userId: string;
  planId: string;
  totalAmount: string;
  amountFen: number;
  status: number;
  productType: number;
  createTime: number;
}

export interface ParsedAfdianWebhook {
  signature: string;
  order: AfdianOrder;
}

export interface VerifiedAfdianPayment {
  eventId: string;
  providerTransactionId: string;
  amountFen: number;
  paidAt: number;
}

export interface AfdianApiEnvelope {
  user_id: string;
  params: string;
  ts: number;
  sign: string;
}

type AfdianFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export function buildAfdianCheckoutUrl(
  planId: string,
  customOrderId: string,
): string {
  if (!AFDIAN_ID.test(planId)) throw new Error("Afdian plan ID is invalid.");
  if (!CUSTOM_ORDER_ID.test(customOrderId)) {
    throw new Error("Afdian custom order ID is invalid.");
  }
  const url = new URL("/order/create", CHECKOUT_ORIGIN);
  url.searchParams.set("plan_id", planId);
  url.searchParams.set("product_type", "0");
  url.searchParams.set("custom_order_id", customOrderId);
  return url.toString();
}

export function createAfdianApiEnvelope(
  outTradeNo: string,
  config: AfdianConfig,
  timestampSeconds = Math.floor(Date.now() / 1000),
): AfdianApiEnvelope {
  if (!OUT_TRADE_NO.test(outTradeNo)) {
    throw new Error("Afdian transaction ID is invalid.");
  }
  assertConfig(config);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new Error("Afdian request timestamp is invalid.");
  }
  const params = JSON.stringify({ out_trade_no: outTradeNo });
  const canonical = `${config.apiToken}params${params}ts${timestampSeconds}user_id${config.userId}`;
  return {
    user_id: config.userId,
    params,
    ts: timestampSeconds,
    sign: createHash("md5").update(canonical, "utf8").digest("hex"),
  };
}

export function parseAfdianWebhook(value: unknown): ParsedAfdianWebhook {
  const root = requiredObject(value, "webhook");
  if (root.ec !== 200) throw new Error("Afdian webhook status is invalid.");
  const signature = requiredString(root.sign, "webhook signature", 1024);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error("Afdian webhook signature is invalid.");
  }
  const data = requiredObject(root.data, "webhook data");
  if (data.type !== "order") throw new Error("Afdian webhook type is invalid.");
  return {
    signature,
    order: parseOrder(requiredObject(data.order, "webhook order"), false),
  };
}

export async function verifyAfdianWebhookSignature(
  order: AfdianOrder,
  signature: string,
  publicKeyPem = AFDIAN_WEBHOOK_PUBLIC_KEY_PEM,
): Promise<boolean> {
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "spki",
    derFromPem(publicKeyPem, "PUBLIC KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = `${order.outTradeNo}${order.userId}${order.planId}${order.totalAmount}`;
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signatureBytes,
    new TextEncoder().encode(signed),
  );
}

export async function queryAfdianOrder(
  outTradeNo: string,
  config: AfdianConfig,
  options: {
    fetcher?: AfdianFetch;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<AfdianOrder | undefined> {
  const orders = await requestAfdianOrders(
    JSON.stringify({ out_trade_no: outTradeNo }),
    config,
    options,
  );
  const matches = orders.filter((order) => order.outTradeNo === outTradeNo);
  if (matches.length > 1) throw new Error("Afdian query returned duplicate orders.");
  return matches[0];
}

export async function queryRecentAfdianOrders(
  config: AfdianConfig,
  options: {
    page: number;
    perPage: number;
    fetcher?: AfdianFetch;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<AfdianOrder[]> {
  if (
    !Number.isSafeInteger(options.page) ||
    options.page < 1 ||
    !Number.isSafeInteger(options.perPage) ||
    options.perPage < 1 ||
    options.perPage > 100
  ) {
    throw new Error("Afdian page query is invalid.");
  }
  return requestAfdianOrders(
    JSON.stringify({ page: options.page, per_page: options.perPage }),
    config,
    options,
  );
}

async function requestAfdianOrders(
  params: string,
  config: AfdianConfig,
  options: {
    fetcher?: AfdianFetch;
    now?: () => number;
    timeoutMs?: number;
  },
): Promise<AfdianOrder[]> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertConfig(config);
  const timestampSeconds = Math.floor(now() / 1000);
  const canonical = `${config.apiToken}params${params}ts${timestampSeconds}user_id${config.userId}`;
  const envelope: AfdianApiEnvelope = {
    user_id: config.userId,
    params,
    ts: timestampSeconds,
    sign: createHash("md5").update(canonical, "utf8").digest("hex"),
  };
  let response: Response;
  try {
    response = await fetcher(QUERY_ORDER_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(envelope),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Afdian query timeout.");
    }
    throw new Error("Afdian query failed.", { cause: error });
  }
  if (response.redirected) throw new Error("Afdian query redirected.");
  if (!response.ok) throw new Error("Afdian query returned an HTTP error.");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Afdian query content type is invalid.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Afdian query response is too large.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new Error("Afdian query response is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Afdian query returned invalid JSON.");
  }
  const root = requiredObject(parsed, "query response");
  if (root.ec !== 200) throw new Error("Afdian provider rejected the query.");
  const data = requiredObject(root.data, "query data");
  if (!Array.isArray(data.list) || data.list.length > 100) {
    throw new Error("Afdian query order list is invalid.");
  }
  return data.list.map((item) =>
    parseOrder(requiredObject(item, "query order"), true),
  );
}

export function assertAfdianOrderMatches(
  localOrder: StoredOrder,
  queried: AfdianOrder,
  webhook: AfdianOrder | undefined,
  config: AfdianConfig,
): VerifiedAfdianPayment {
  assertConfig(config);
  const expectedPlanId =
    localOrder.planId === "pro_monthly"
      ? config.monthlyPlanId
      : config.yearlyPlanId;
  if (
    queried.customOrderId !== localOrder.customOrderId ||
    queried.planId !== expectedPlanId ||
    queried.amountFen !== localOrder.amountFen ||
    queried.status !== 2 ||
    queried.productType !== 0 ||
    !Number.isSafeInteger(queried.createTime) ||
    queried.createTime <= 0
  ) {
    throw new Error("Afdian order does not match the local order.");
  }
  const paidAt = queried.createTime * 1000;
  if (paidAt < localOrder.createdAt || paidAt > localOrder.expiresAt) {
    throw new Error("Afdian payment falls outside the local order window.");
  }
  if (
    webhook &&
    (webhook.outTradeNo !== queried.outTradeNo ||
      webhook.customOrderId !== queried.customOrderId ||
      webhook.userId !== queried.userId ||
      webhook.planId !== queried.planId ||
      webhook.amountFen !== queried.amountFen ||
      webhook.status !== queried.status ||
      webhook.productType !== queried.productType)
  ) {
    throw new Error("Afdian webhook does not match the queried order.");
  }
  return {
    eventId: queried.outTradeNo,
    providerTransactionId: queried.outTradeNo,
    amountFen: queried.amountFen,
    paidAt,
  };
}

export function afdianConfig(config: RuntimeConfig): AfdianConfig {
  return config.afdian;
}

function parseOrder(value: Record<string, unknown>, requireCreateTime: boolean): AfdianOrder {
  const totalAmount = requiredString(value.total_amount, "order amount", 32);
  const createTime = value.create_time == null ? 0 : requiredInteger(value.create_time, "order time");
  if (requireCreateTime && createTime <= 0) {
    throw new Error("Afdian order time is invalid.");
  }
  return {
    outTradeNo: patternedString(value.out_trade_no, "transaction ID", OUT_TRADE_NO),
    customOrderId: patternedString(
      value.custom_order_id,
      "custom order ID",
      CUSTOM_ORDER_ID,
    ),
    userId: patternedString(value.user_id, "payer ID", AFDIAN_ID),
    planId: patternedString(value.plan_id, "plan ID", AFDIAN_ID),
    totalAmount,
    amountFen: moneyToFen(totalAmount),
    status: requiredInteger(value.status, "order status"),
    productType: requiredInteger(value.product_type, "product type"),
    createTime,
  };
}

function moneyToFen(value: string): number {
  const match = value.match(/^(0|[1-9]\d{0,7})\.(\d{2})$/);
  if (!match) throw new Error("Afdian order amount is invalid.");
  const amount = Number(match[1]) * 100 + Number(match[2]);
  if (!Number.isSafeInteger(amount)) throw new Error("Afdian order amount is invalid.");
  return amount;
}

function assertConfig(config: AfdianConfig): void {
  if (
    !AFDIAN_ID.test(config.userId) ||
    !AFDIAN_ID.test(config.monthlyPlanId) ||
    !AFDIAN_ID.test(config.yearlyPlanId) ||
    config.apiToken.length < 16 ||
    /\s/.test(config.apiToken)
  ) {
    throw new Error("Afdian configuration is invalid.");
  }
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Afdian ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Afdian ${name} is invalid.`);
  }
  return value;
}

function patternedString(
  value: unknown,
  name: string,
  pattern: RegExp,
): string {
  const text = requiredString(value, name, 128);
  if (!pattern.test(text)) throw new Error(`Afdian ${name} is invalid.`);
  return text;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Afdian ${name} is invalid.`);
  return Number(value);
}

function derFromPem(pem: string, label: "PUBLIC KEY"): ArrayBuffer {
  const match = pem.trim().match(
    new RegExp(`^-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----$`),
  );
  if (!match) throw new Error("Afdian public key is invalid.");
  return base64ToBytes(match[1].replace(/\s/g, "")).buffer;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
