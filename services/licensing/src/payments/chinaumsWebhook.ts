import type { EntitlementRecord } from "../database.js";
import { LicensingService, PaymentMismatchError } from "../domain.js";
import { verifyChinaumsNotificationSignature } from "./chinaumsAuth.js";
import { parseChinaumsDateTime } from "./chinaumsQr.js";

const MAX_CALLBACK_BYTES = 64 * 1024;
const MAX_FIELDS = 64;
const MAX_FIELD_VALUE_BYTES = 32 * 1024;

export interface ChinaumsWebhookConfig {
  merchantId: string;
  terminalId: string;
  notificationKey: string;
}

export interface ProcessedChinaumsWebhook {
  isReplay: boolean;
  entitlement: EntitlementRecord;
}

export class ChinaumsWebhookProcessor {
  constructor(
    private readonly config: ChinaumsWebhookConfig,
    private readonly licensing: LicensingService,
    private readonly runtime: { now: () => number } = { now: Date.now },
  ) {
    if (!/^\d{15}$/.test(config.merchantId)) {
      throw new Error("ChinaUMS webhook merchant ID is invalid.");
    }
    if (!/^[A-Za-z0-9]{8}$/.test(config.terminalId)) {
      throw new Error("ChinaUMS webhook terminal ID is invalid.");
    }
    if (
      !config.notificationKey ||
      Buffer.byteLength(config.notificationKey, "utf8") > 1_024
    ) {
      throw new Error("ChinaUMS webhook notification key is invalid.");
    }
  }

  process(rawBody: string): ProcessedChinaumsWebhook {
    const fields = parseNotificationForm(rawBody);
    const signature = requiredField(fields, "sign", 64);
    if (
      !verifyChinaumsNotificationSignature(
        fields,
        this.config.notificationKey,
        signature,
      )
    ) {
      throw new Error("ChinaUMS callback signature is invalid.");
    }
    const signType = fields.get("signType");
    if (signType != null && signType !== "SHA256") {
      throw new Error("ChinaUMS callback must use SHA256.");
    }
    if (
      fields.has("mid") &&
      requiredField(fields, "mid", 32) !== this.config.merchantId
    ) {
      throw new Error("ChinaUMS callback merchant does not match.");
    }
    if (
      fields.has("tid") &&
      requiredField(fields, "tid", 32) !== this.config.terminalId
    ) {
      throw new Error("ChinaUMS callback terminal does not match.");
    }
    if (
      fields.has("instMid") &&
      requiredField(fields, "instMid", 32) !== "QRPAYDEFAULT"
    ) {
      throw new Error("ChinaUMS callback business type does not match.");
    }
    if (requiredField(fields, "billStatus", 32) !== "PAID") {
      throw new Error("ChinaUMS callback bill is not paid.");
    }
    const billNo = requiredPatternField(
      fields,
      "billNo",
      /^[A-Za-z0-9]{7,31}$/,
    );
    const order = this.licensing.findOrderByProviderOrderId(billNo);
    if (!order || order.provider !== "chinaums-qr") {
      throw new Error("ChinaUMS callback order was not found.");
    }
    const amountFen = positiveIntegerField(fields, "totalAmount");
    const payment = parsePayment(fields);
    if (payment.status !== "TRADE_SUCCESS") {
      throw new Error("ChinaUMS callback transaction was not successful.");
    }
    const paidAt = parseChinaumsDateTime(
      requiredString(payment.payTime, "payment time", 32),
    );
    const eventId = requiredPatternField(
      fields,
      "notifyId",
      /^[A-Za-z0-9_-]{1,128}$/,
    );
    requiredPatternField(fields, "seqId", /^[A-Za-z0-9_-]{1,96}$/);
    const paymentSequence = requiredString(
      payment.paySeqId,
      "payment sequence",
      96,
    );
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(paymentSequence)) {
      throw new Error("ChinaUMS callback payment sequence is invalid.");
    }
    try {
      return this.licensing.recordWebhookPayment(eventId, this.runtime.now(), {
        orderId: order.id,
        transactionId: `chinaums_${paymentSequence}`,
        amountFen,
        paidAt,
      });
    } catch (error) {
      if (error instanceof PaymentMismatchError) {
        throw new Error("ChinaUMS callback amount does not match.", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

function parseNotificationForm(rawBody: string): Map<string, string> {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_CALLBACK_BYTES) {
    throw new Error("ChinaUMS callback body is too large.");
  }
  const result = new Map<string, string>();
  const parameters = new URLSearchParams(rawBody);
  let count = 0;
  for (const [key, value] of parameters) {
    count += 1;
    if (count > MAX_FIELDS) {
      throw new Error("ChinaUMS callback has too many fields.");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new Error("ChinaUMS callback field name is invalid.");
    }
    if (
      value.includes("\uFFFD") ||
      Buffer.byteLength(value, "utf8") > MAX_FIELD_VALUE_BYTES
    ) {
      throw new Error("ChinaUMS callback field value is invalid.");
    }
    if (result.has(key)) {
      throw new Error("ChinaUMS callback contains a duplicate field.");
    }
    result.set(key, value);
  }
  return result;
}

function parsePayment(
  fields: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const raw = requiredField(fields, "billPayment", MAX_FIELD_VALUE_BYTES);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("ChinaUMS callback payment details are invalid.");
  }
}

function requiredField(
  fields: ReadonlyMap<string, string>,
  name: string,
  maxLength: number,
): string {
  const value = fields.get(name);
  if (value == null || value.length === 0 || value.length > maxLength) {
    throw new Error(`ChinaUMS callback ${name} is invalid.`);
  }
  return value;
}

function requiredPatternField(
  fields: ReadonlyMap<string, string>,
  name: string,
  pattern: RegExp,
): string {
  const value = requiredField(fields, name, 128);
  if (!pattern.test(value)) {
    throw new Error(`ChinaUMS callback ${name} is invalid.`);
  }
  return value;
}

function positiveIntegerField(
  fields: ReadonlyMap<string, string>,
  name: string,
): number {
  const raw = requiredField(fields, name, 16);
  if (!/^\d{1,9}$/.test(raw)) {
    throw new Error(`ChinaUMS callback ${name} is invalid.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) {
    throw new Error(`ChinaUMS callback ${name} is invalid.`);
  }
  return value;
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
    throw new Error(`ChinaUMS callback ${label} is invalid.`);
  }
  return value;
}
