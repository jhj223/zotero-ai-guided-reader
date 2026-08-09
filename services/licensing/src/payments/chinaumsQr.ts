import { createHash, randomInt, randomUUID } from "node:crypto";
import { createChinaumsAuthorization } from "./chinaumsAuth.js";
import type {
  CreatedPayment,
  PaymentOrderInput,
  PaymentProvider,
} from "./provider.js";

const CREATE_BILL_PATH = "/v1/netpay/bills/get-qrcode";
const QUERY_BILL_PATH = "/v1/netpay/bills/query";
const MAX_RESPONSE_BYTES = 64 * 1024;
const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface ChinaumsQrConfig {
  environment: "test" | "production";
  appId: string;
  appKey: string;
  merchantId: string;
  terminalId: string;
  messageSourceId: string;
  notifyUrl: string;
}

export type ChinaumsBillQueryResult =
  | { status: "pending" }
  | {
      status: "paid";
      eventId: string;
      transactionId: string;
      amountFen: number;
      paidAt: number;
    };

export class ChinaumsQrProvider implements PaymentProvider {
  readonly kind = "chinaums-qr" as const;

  constructor(
    private readonly config: ChinaumsQrConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runtime: {
      now: () => number;
      nonce: () => string;
      randomDigits: () => string;
    } = {
      now: Date.now,
      nonce: () => randomUUID().replaceAll("-", ""),
      randomDigits: () => String(randomInt(0, 10_000_000)).padStart(7, "0"),
    },
  ) {
    validateConfig(config);
  }

  async createPayment(input: PaymentOrderInput): Promise<CreatedPayment> {
    const now = this.runtime.now();
    validatePaymentInput(input, now);
    const randomDigits = this.runtime.randomDigits();
    if (!/^\d{7}$/.test(randomDigits)) {
      throw new Error("ChinaUMS bill random digits are invalid.");
    }
    const billDate = formatChinaumsDate(now);
    const billNo =
      this.config.messageSourceId +
      formatChinaumsTimestampWithMilliseconds(now) +
      randomDigits;
    const requestBody = JSON.stringify({
      requestTimestamp: formatChinaumsDateTime(now),
      mid: this.config.merchantId,
      tid: this.config.terminalId,
      instMid: "QRPAYDEFAULT",
      billNo,
      billDate,
      billDesc: truncateCharacters(input.description.trim(), 128),
      totalAmount: input.amountFen,
      expireTime: formatChinaumsDateTime(input.expiresAt),
      notifyUrl: this.config.notifyUrl,
      walletOption: "MULTIPLE",
    });
    const payload = await this.request(CREATE_BILL_PATH, requestBody, now);
    if (payload.errCode !== "SUCCESS") {
      throw new Error("ChinaUMS bill creation was rejected.");
    }
    validateEchoedBill(payload, this.config, billNo, billDate);
    const codeUrl = validateQrCodeUrl(
      requiredString(payload.billQRCode, "QR code URL", 2_048),
      this.config.environment,
    );
    return { providerOrderId: billNo, codeUrl };
  }

  async queryPayment(
    providerOrderId: string,
  ): Promise<ChinaumsBillQueryResult> {
    const billDate = billDateFromProviderOrderId(
      providerOrderId,
      this.config.messageSourceId,
    );
    const now = this.runtime.now();
    const requestBody = JSON.stringify({
      requestTimestamp: formatChinaumsDateTime(now),
      mid: this.config.merchantId,
      tid: this.config.terminalId,
      instMid: "QRPAYDEFAULT",
      billNo: providerOrderId,
      billDate,
    });
    const payload = await this.request(QUERY_BILL_PATH, requestBody, now);
    if (payload.errCode !== "SUCCESS") {
      throw new Error("ChinaUMS bill query was rejected.");
    }
    validateEchoedBill(payload, this.config, providerOrderId, billDate);
    const billStatus = requiredString(payload.billStatus, "bill status", 32);
    if (billStatus !== "PAID") return { status: "pending" };
    const payment = requiredObject(payload.billPayment, "payment details");
    if (payment.status !== "TRADE_SUCCESS") {
      throw new Error("ChinaUMS response transaction was not successful.");
    }
    const paymentSequence = requiredString(
      payment.paySeqId,
      "payment sequence",
      96,
    );
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(paymentSequence)) {
      throw new Error("ChinaUMS response payment sequence is invalid.");
    }
    const amountFen = positiveInteger(payload.totalAmount, "amount");
    const paidAt = parseChinaumsDateTime(
      requiredString(payment.payTime, "payment time", 32),
    );
    const eventDigest = createHash("sha256")
      .update(providerOrderId)
      .update("\0")
      .update(paymentSequence)
      .digest("base64url")
      .slice(0, 32);
    return {
      status: "paid",
      eventId: `chinaums_query_${eventDigest}`,
      transactionId: `chinaums_${paymentSequence}`,
      amountFen,
      paidAt,
    };
  }

  private async request(
    path: string,
    requestBody: string,
    now: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(
      `${apiOrigin(this.config.environment)}${path}`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: createChinaumsAuthorization({
            appId: this.config.appId,
            appKey: this.config.appKey,
            timestamp: formatChinaumsAuthorizationTime(now),
            nonce: this.runtime.nonce(),
            body: requestBody,
          }),
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "zotero-ai-guided-reader-licensing/1",
        },
        body: requestBody,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(`ChinaUMS request failed (HTTP ${response.status}).`);
    }
    return payload;
  }
}

export function formatChinaumsDateTime(timestampMs: number): string {
  const parts = chinaDateParts(timestampMs);
  return `${parts.date} ${parts.hours}:${parts.minutes}:${parts.seconds}`;
}

export function formatChinaumsDate(timestampMs: number): string {
  return chinaDateParts(timestampMs).date;
}

export function parseChinaumsDateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("ChinaUMS response payment time is invalid.");
  const components = match.slice(1).map(Number);
  const timestamp =
    Date.UTC(
      components[0],
      components[1] - 1,
      components[2],
      components[3],
      components[4],
      components[5],
    ) - CHINA_TIME_OFFSET_MS;
  const roundTrip = new Date(timestamp + CHINA_TIME_OFFSET_MS);
  if (
    roundTrip.getUTCFullYear() !== components[0] ||
    roundTrip.getUTCMonth() + 1 !== components[1] ||
    roundTrip.getUTCDate() !== components[2] ||
    roundTrip.getUTCHours() !== components[3] ||
    roundTrip.getUTCMinutes() !== components[4] ||
    roundTrip.getUTCSeconds() !== components[5]
  ) {
    throw new Error("ChinaUMS response payment time is invalid.");
  }
  return timestamp;
}

function formatChinaumsAuthorizationTime(timestampMs: number): string {
  const parts = chinaDateParts(timestampMs);
  return `${parts.date.replaceAll("-", "")}${parts.hours}${parts.minutes}${parts.seconds}`;
}

function formatChinaumsTimestampWithMilliseconds(timestampMs: number): string {
  const shifted = new Date(timestampMs + CHINA_TIME_OFFSET_MS);
  const parts = chinaDateParts(timestampMs);
  return (
    parts.date.replaceAll("-", "") +
    parts.hours +
    parts.minutes +
    parts.seconds +
    String(shifted.getUTCMilliseconds()).padStart(3, "0")
  );
}

function chinaDateParts(timestampMs: number): {
  date: string;
  hours: string;
  minutes: string;
  seconds: string;
} {
  if (!Number.isFinite(timestampMs)) {
    throw new Error("ChinaUMS timestamp is invalid.");
  }
  const date = new Date(timestampMs + CHINA_TIME_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return {
    date: `${year}-${month}-${day}`,
    hours: String(date.getUTCHours()).padStart(2, "0"),
    minutes: String(date.getUTCMinutes()).padStart(2, "0"),
    seconds: String(date.getUTCSeconds()).padStart(2, "0"),
  };
}

function apiOrigin(environment: ChinaumsQrConfig["environment"]): string {
  return environment === "production"
    ? "https://api-mop.chinaums.com"
    : "https://test-api-open.chinaums.com";
}

function validateConfig(config: ChinaumsQrConfig): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.appId)) {
    throw new Error("ChinaUMS AppId is invalid.");
  }
  if (
    config.appKey.length === 0 ||
    Buffer.byteLength(config.appKey, "utf8") > 1_024
  ) {
    throw new Error("ChinaUMS AppKey is invalid.");
  }
  if (!/^\d{15}$/.test(config.merchantId)) {
    throw new Error("ChinaUMS merchant ID is invalid.");
  }
  if (!/^[A-Za-z0-9]{8}$/.test(config.terminalId)) {
    throw new Error("ChinaUMS terminal ID is invalid.");
  }
  if (!/^[A-Za-z0-9]{4}$/.test(config.messageSourceId)) {
    throw new Error("ChinaUMS message source ID is invalid.");
  }
  let notifyUrl: URL;
  try {
    notifyUrl = new URL(config.notifyUrl);
  } catch {
    throw new Error("ChinaUMS notify URL is invalid.");
  }
  if (
    notifyUrl.protocol !== "https:" ||
    notifyUrl.username ||
    notifyUrl.password ||
    notifyUrl.search ||
    notifyUrl.hash
  ) {
    throw new Error("ChinaUMS notify URL must use HTTPS.");
  }
}

function validatePaymentInput(input: PaymentOrderInput, now: number): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.orderId)) {
    throw new Error("ChinaUMS local order ID is invalid.");
  }
  if (
    !Number.isSafeInteger(input.amountFen) ||
    input.amountFen <= 0 ||
    input.amountFen > 100_000_000
  ) {
    throw new Error("ChinaUMS payment amount is invalid.");
  }
  if (!input.description.trim()) {
    throw new Error("ChinaUMS bill description is required.");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new Error("ChinaUMS bill expiry is invalid.");
  }
}

function billDateFromProviderOrderId(
  providerOrderId: string,
  messageSourceId: string,
): string {
  const pattern = new RegExp(
    `^${messageSourceId}(\\d{4})(\\d{2})(\\d{2})\\d{16}$`,
  );
  const match = pattern.exec(providerOrderId);
  if (!match) throw new Error("ChinaUMS bill number is invalid.");
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  parseChinaumsDateTime(`${date} 00:00:00`);
  return date;
}

async function readJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength != null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    throw new Error("ChinaUMS response is too large.");
  }
  if (!response.body) {
    throw new Error("ChinaUMS response is not valid JSON.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("ChinaUMS response is too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof Error && /too large/i.test(error.message)) {
      throw error;
    }
    throw new Error("ChinaUMS response is not valid UTF-8.", { cause: error });
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("ChinaUMS response is not valid JSON.");
  }
}

function validateEchoedBill(
  payload: Record<string, unknown>,
  config: ChinaumsQrConfig,
  billNo: string,
  billDate: string,
): void {
  if (payload.mid !== config.merchantId) {
    throw new Error("ChinaUMS response merchant does not match.");
  }
  if (payload.tid !== config.terminalId) {
    throw new Error("ChinaUMS response terminal does not match.");
  }
  if (payload.instMid !== "QRPAYDEFAULT") {
    throw new Error("ChinaUMS response business type does not match.");
  }
  if (payload.billNo !== billNo || payload.billDate !== billDate) {
    throw new Error("ChinaUMS response bill does not match.");
  }
}

function validateQrCodeUrl(
  value: string,
  environment: ChinaumsQrConfig["environment"],
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChinaUMS response QR code URL is invalid.");
  }
  const expectedHost =
    environment === "production" ? "qr.chinaums.com" : "qr-test2.chinaums.com";
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHost ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("ChinaUMS response QR code URL is invalid.");
  }
  return url.toString();
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`ChinaUMS response ${label} is invalid.`);
  }
  return value;
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error(`ChinaUMS response ${label} is invalid.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ChinaUMS response ${label} is invalid.`);
  }
  return parsed as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized =
    typeof value === "string" && /^\d{1,9}$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > 100_000_000
  ) {
    throw new Error(`ChinaUMS response ${label} is invalid.`);
  }
  return normalized;
}

function truncateCharacters(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}
