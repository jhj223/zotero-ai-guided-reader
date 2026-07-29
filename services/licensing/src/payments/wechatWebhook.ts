import type { KeyLike } from "node:crypto";
import type { EntitlementRecord } from "../database.js";
import type { LicensingService } from "../domain.js";
import { decryptWechatResource, verifyWechatMessage } from "./wechatNative.js";

const MAX_CALLBACK_BYTES = 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface WechatWebhookConfig {
  merchantId: string;
  appId: string;
  apiV3Key: string;
  platformPublicKeys: ReadonlyMap<string, KeyLike>;
}

export interface ProcessedWechatWebhook {
  isReplay: boolean;
  entitlement: EntitlementRecord;
}

export class WechatWebhookProcessor {
  constructor(
    private readonly config: WechatWebhookConfig,
    private readonly licensing: LicensingService,
    private readonly runtime: { nowSeconds: () => number } = {
      nowSeconds: () => Math.floor(Date.now() / 1000),
    },
  ) {}

  process(headers: Headers, rawBody: string): ProcessedWechatWebhook {
    if (Buffer.byteLength(rawBody, "utf8") > MAX_CALLBACK_BYTES) {
      throw new Error("Wechat Pay callback body is too large.");
    }
    const timestampText = requiredHeader(headers, "Wechatpay-Timestamp");
    const nonce = requiredHeader(headers, "Wechatpay-Nonce");
    const serial = requiredHeader(headers, "Wechatpay-Serial");
    const signature = requiredHeader(headers, "Wechatpay-Signature");
    const timestamp = Number(timestampText);
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(this.runtime.nowSeconds() - timestamp) >
        MAX_TIMESTAMP_SKEW_SECONDS
    ) {
      throw new Error("Wechat Pay callback timestamp is invalid or stale.");
    }
    const platformPublicKey = this.config.platformPublicKeys.get(serial);
    if (!platformPublicKey) {
      throw new Error("Wechat Pay callback used an unknown public key.");
    }
    if (
      !verifyWechatMessage(
        `${timestampText}\n${nonce}\n${rawBody}\n`,
        signature,
        platformPublicKey,
      )
    ) {
      throw new Error("Wechat Pay callback signature is invalid.");
    }

    const envelope = parseObject(rawBody, "callback");
    const eventId = requiredString(envelope.id, "callback event id", 128);
    if (envelope.event_type !== "TRANSACTION.SUCCESS") {
      throw new Error("Wechat Pay callback event type is not supported.");
    }
    if (envelope.resource_type !== "encrypt-resource") {
      throw new Error("Wechat Pay callback resource type is invalid.");
    }
    const resource = objectValue(envelope.resource, "callback resource");
    if (resource.algorithm !== "AEAD_AES_256_GCM") {
      throw new Error("Wechat Pay callback encryption algorithm is invalid.");
    }
    const plaintext = decryptWechatResource(
      {
        ciphertext: requiredString(
          resource.ciphertext,
          "resource ciphertext",
          64 * 1024,
        ),
        nonce: requiredString(resource.nonce, "resource nonce", 64),
        associatedData:
          typeof resource.associated_data === "string"
            ? resource.associated_data
            : undefined,
      },
      this.config.apiV3Key,
    );
    const transaction = parseObject(plaintext, "transaction");
    if (transaction.mchid !== this.config.merchantId) {
      throw new Error("Wechat Pay callback merchant does not match.");
    }
    if (transaction.appid !== this.config.appId) {
      throw new Error("Wechat Pay callback app does not match.");
    }
    if (transaction.trade_state !== "SUCCESS") {
      throw new Error("Wechat Pay transaction was not successful.");
    }
    const amount = objectValue(transaction.amount, "transaction amount");
    if (!Number.isSafeInteger(amount.total) || Number(amount.total) <= 0) {
      throw new Error("Wechat Pay callback amount is invalid.");
    }
    if (amount.currency !== "CNY") {
      throw new Error("Wechat Pay callback currency does not match.");
    }
    const successTime = requiredString(
      transaction.success_time,
      "transaction success time",
      64,
    );
    const paidAt = Date.parse(successTime);
    if (!Number.isFinite(paidAt)) {
      throw new Error("Wechat Pay callback success time is invalid.");
    }

    return this.licensing.recordWebhookPayment(
      eventId,
      this.runtime.nowSeconds() * 1000,
      {
        orderId: requiredString(
          transaction.out_trade_no,
          "merchant order id",
          128,
        ),
        transactionId: requiredString(
          transaction.transaction_id,
          "Wechat Pay transaction id",
          128,
        ),
        amountFen: Number(amount.total),
        paidAt,
      },
    );
  }
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) throw new Error(`Wechat Pay callback is missing ${name}.`);
  return value;
}

function parseObject(rawJson: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(rawJson) as unknown;
    return objectValue(value, label);
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be an object")) {
      throw error;
    }
    throw new Error(`Wechat Pay ${label} is not valid JSON.`, {
      cause: error,
    });
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Wechat Pay ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
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
    throw new Error(`Wechat Pay ${label} is invalid.`);
  }
  return value;
}
