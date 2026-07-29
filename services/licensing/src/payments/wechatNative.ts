import {
  createDecipheriv,
  createSign,
  createVerify,
  type KeyLike,
} from "node:crypto";
import type {
  CreatedPayment,
  PaymentOrderInput,
  PaymentProvider,
} from "./provider.js";

const NATIVE_PATH = "/v3/pay/transactions/native";
const AUTH_SCHEME = "WECHATPAY2-SHA256-RSA2048";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface DirectWechatNativeConfig {
  mode: "direct";
  merchantId: string;
  appId: string;
  merchantSerial: string;
  merchantPrivateKey: KeyLike;
  apiV3Key: string;
  notifyUrl: string;
  platformPublicKeys: ReadonlyMap<string, KeyLike>;
}

export class WechatNativeProvider implements PaymentProvider {
  constructor(
    private readonly config: DirectWechatNativeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly runtime: {
      nowSeconds: () => number;
      nonce: () => string;
    } = {
      nowSeconds: () => Math.floor(Date.now() / 1000),
      nonce: () => crypto.randomUUID().replace(/-/g, ""),
    },
  ) {
    if (!/^https:\/\//i.test(config.notifyUrl)) {
      throw new Error("Wechat Pay notify URL must use HTTPS.");
    }
    if (Buffer.byteLength(config.apiV3Key, "utf8") !== 32) {
      throw new Error("Wechat Pay APIv3 key must contain exactly 32 bytes.");
    }
  }

  async createPayment(input: PaymentOrderInput): Promise<CreatedPayment> {
    const requestBody = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.merchantId,
      description: input.description,
      out_trade_no: input.orderId,
      time_expire: new Date(input.expiresAt).toISOString(),
      notify_url: this.config.notifyUrl,
      amount: { total: input.amountFen, currency: "CNY" },
    });
    const timestamp = this.runtime.nowSeconds();
    const nonce = this.runtime.nonce();
    const authorization = createWechatAuthorization({
      method: "POST",
      canonicalUrl: NATIVE_PATH,
      body: requestBody,
      merchantId: this.config.merchantId,
      merchantSerial: this.config.merchantSerial,
      merchantPrivateKey: this.config.merchantPrivateKey,
      timestamp,
      nonce,
    });
    const response = await this.fetchImpl(
      `https://api.mch.weixin.qq.com${NATIVE_PATH}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "Content-Type": "application/json",
          "User-Agent": "zotero-ai-guided-reader-licensing/1",
        },
        body: requestBody,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const declaredLength = Number(response.headers.get("Content-Length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Wechat Pay response is too large.");
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Wechat Pay response is too large.");
    }
    if (!response.ok) {
      throw new Error(
        `Wechat Pay Native order failed (HTTP ${response.status}).`,
      );
    }
    this.verifyWechatResponse(response.headers, responseBody);
    const payload = parseJson(responseBody);
    if (typeof payload.code_url !== "string" || !payload.code_url) {
      throw new Error("Wechat Pay response did not include code_url.");
    }
    if (!payload.code_url.startsWith("weixin://wxpay/")) {
      throw new Error("Wechat Pay response included an invalid code_url.");
    }
    return {
      providerOrderId: input.orderId,
      codeUrl: payload.code_url,
    };
  }

  private verifyWechatResponse(headers: Headers, rawBody: string): void {
    const timestamp = requiredHeader(headers, "Wechatpay-Timestamp");
    const nonce = requiredHeader(headers, "Wechatpay-Nonce");
    const serial = requiredHeader(headers, "Wechatpay-Serial");
    const signature = requiredHeader(headers, "Wechatpay-Signature");
    const responseTimestamp = Number(timestamp);
    if (
      !Number.isSafeInteger(responseTimestamp) ||
      Math.abs(this.runtime.nowSeconds() - responseTimestamp) >
        MAX_TIMESTAMP_SKEW_SECONDS
    ) {
      throw new Error("Wechat Pay response timestamp is invalid or stale.");
    }
    const publicKey = this.config.platformPublicKeys.get(serial);
    if (!publicKey) {
      throw new Error("Wechat Pay response used an unknown public key.");
    }
    if (
      !verifyWechatMessage(
        `${timestamp}\n${nonce}\n${rawBody}\n`,
        signature,
        publicKey,
      )
    ) {
      throw new Error("Wechat Pay response signature is invalid.");
    }
  }
}

export function createWechatAuthorization(input: {
  method: string;
  canonicalUrl: string;
  body: string;
  merchantId: string;
  merchantSerial: string;
  merchantPrivateKey: KeyLike;
  timestamp: number;
  nonce: string;
}): string {
  const message = [
    input.method.toUpperCase(),
    input.canonicalUrl,
    String(input.timestamp),
    input.nonce,
    input.body,
    "",
  ].join("\n");
  const signer = createSign("RSA-SHA256");
  signer.update(message, "utf8");
  signer.end();
  const signature = signer.sign(input.merchantPrivateKey).toString("base64");
  return (
    `${AUTH_SCHEME} mchid="${input.merchantId}",` +
    `nonce_str="${input.nonce}",timestamp="${input.timestamp}",` +
    `serial_no="${input.merchantSerial}",signature="${signature}"`
  );
}

export function verifyWechatMessage(
  message: string,
  signature: string,
  publicKey: KeyLike,
): boolean {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(message, "utf8");
  verifier.end();
  try {
    return verifier.verify(publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function decryptWechatResource(
  resource: {
    ciphertext: string;
    nonce: string;
    associatedData?: string;
  },
  apiV3Key: string,
): string {
  if (Buffer.byteLength(apiV3Key, "utf8") !== 32) {
    throw new Error("Wechat Pay APIv3 key must contain exactly 32 bytes.");
  }
  const encrypted = Buffer.from(resource.ciphertext, "base64");
  if (encrypted.length <= 16) {
    throw new Error("Wechat Pay callback ciphertext is too short.");
  }
  const ciphertext = encrypted.subarray(0, -16);
  const authenticationTag = encrypted.subarray(-16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(resource.nonce, "utf8"),
  );
  decipher.setAuthTag(authenticationTag);
  decipher.setAAD(Buffer.from(resource.associatedData || "", "utf8"));
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) throw new Error(`Wechat Pay response is missing ${name}.`);
  return value;
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Wechat Pay response is not valid JSON.");
  }
}
