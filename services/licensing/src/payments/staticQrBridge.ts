import {
  createHash,
  createPublicKey,
  KeyObject,
  verify,
  type KeyLike,
} from "node:crypto";
import type {
  StaticQrReceiptInput,
  StaticQrReceiptResult,
} from "../database.js";
import type { LicensingStore } from "../database.js";
import type { LicensingService } from "../domain.js";

const HEARTBEAT_PATH = "/v1/merchant/heartbeat";
const RECEIPT_PATH = "/v1/merchant/receipts";
const HEARTBEAT_SCHEMA = "wechat-commercial-heartbeat/v1";
const RECEIPT_SCHEMA = "wechat-commercial-receipt/v1";
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const WATCHER_STALE_MS = 120 * 1000;
const NONCE_RETENTION_MS = 10 * 60 * 1000;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{80,128}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface StaticQrAvailability {
  available: boolean;
  reason: "PAYMENT_WATCHER_OFFLINE" | null;
}

export class StaticQrBridge {
  constructor(
    private readonly dependencies: {
      store: LicensingStore;
      licensing: LicensingService;
      watcherPublicKeys: ReadonlyMap<string, KeyLike>;
    },
    private readonly runtime: {
      now: () => number;
    } = { now: Date.now },
  ) {
    if (dependencies.watcherPublicKeys.size === 0) {
      throw new Error("At least one watcher public key is required.");
    }
    for (const [keyId, publicKey] of dependencies.watcherPublicKeys) {
      const normalizedKey =
        publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey);
      if (
        !KEY_ID_PATTERN.test(keyId) ||
        normalizedKey.type !== "public" ||
        normalizedKey.asymmetricKeyType !== "ed25519"
      ) {
        throw new Error("Watcher public keys must be Ed25519 keys.");
      }
    }
  }

  availability(): StaticQrAvailability {
    return this.dependencies.store.hasHealthyWatcher(
      this.runtime.now(),
      WATCHER_STALE_MS,
    )
      ? { available: true, reason: null }
      : { available: false, reason: "PAYMENT_WATCHER_OFFLINE" };
  }

  processHeartbeat(headers: Headers, rawBody: string): void {
    const verified = this.verifyRequest(headers, rawBody, HEARTBEAT_PATH);
    const body = parseJsonObject(rawBody);
    assertExactKeys(body, [
      "schema",
      "keyId",
      "watcherVersion",
      "state",
      "outboxPending",
    ]);
    if (
      body.schema !== HEARTBEAT_SCHEMA ||
      body.keyId !== verified.keyId ||
      typeof body.watcherVersion !== "string" ||
      !VERSION_PATTERN.test(body.watcherVersion) ||
      (body.state !== "healthy" &&
        body.state !== "parser_paused" &&
        body.state !== "wechat_offline") ||
      !isSafeIntegerBetween(body.outboxPending, 0, 1_000_000)
    ) {
      throw new Error("INVALID_HEARTBEAT_EVENT");
    }
    this.dependencies.store.recordWatcherHeartbeat({
      keyId: verified.keyId,
      watcherVersion: body.watcherVersion,
      state: body.state,
      outboxPending: body.outboxPending,
      receivedAt: this.runtime.now(),
      nonceHash: verified.nonceHash,
      nonceRetentionMs: NONCE_RETENTION_MS,
    });
  }

  processReceipt(headers: Headers, rawBody: string): StaticQrReceiptResult {
    const verified = this.verifyRequest(headers, rawBody, RECEIPT_PATH);
    const body = parseJsonObject(rawBody);
    assertExactKeys(body, [
      "schema",
      "keyId",
      "eventId",
      "sequence",
      "observedAt",
      "paidAt",
      "amountFen",
      "currency",
      "source",
      "messageFingerprint",
    ]);
    const input = parseReceipt(body, verified.keyId, this.runtime.now());
    return this.dependencies.licensing.recordStaticQrReceipt(
      input,
      this.runtime.now(),
      verified.nonceHash,
    );
  }

  private verifyRequest(
    headers: Headers,
    rawBody: string,
    path: string,
  ): { keyId: string; nonceHash: string } {
    try {
      const keyId = headers.get("x-receipt-key-id") || "";
      const timestampText = headers.get("x-receipt-timestamp") || "";
      const nonce = headers.get("x-receipt-nonce") || "";
      const signatureText = headers.get("x-receipt-signature") || "";
      if (
        !KEY_ID_PATTERN.test(keyId) ||
        !/^[0-9]{10,12}$/.test(timestampText) ||
        !NONCE_PATTERN.test(nonce) ||
        !SIGNATURE_PATTERN.test(signatureText)
      ) {
        throw new Error("invalid headers");
      }
      const publicKey = this.dependencies.watcherPublicKeys.get(keyId);
      const timestamp = Number(timestampText);
      const nowSeconds = Math.floor(this.runtime.now() / 1000);
      if (
        !publicKey ||
        !Number.isSafeInteger(timestamp) ||
        Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS
      ) {
        throw new Error("invalid signer or timestamp");
      }
      const digest = createHash("sha256")
        .update(rawBody, "utf8")
        .digest("base64url");
      const message = ["POST", path, timestampText, nonce, digest, ""].join(
        "\n",
      );
      const signature = Buffer.from(signatureText, "base64url");
      if (!verify(null, Buffer.from(message, "utf8"), publicKey, signature)) {
        throw new Error("invalid signature");
      }
      return {
        keyId,
        nonceHash: createHash("sha256")
          .update(keyId, "utf8")
          .update("\0")
          .update(nonce, "utf8")
          .digest("hex"),
      };
    } catch {
      throw new Error("MERCHANT_SIGNATURE_INVALID");
    }
  }
}

function parseReceipt(
  body: Record<string, unknown>,
  keyId: string,
  currentTime: number,
): StaticQrReceiptInput {
  const observedAt = parseIsoTimestamp(body.observedAt);
  const paidAt = parseIsoTimestamp(body.paidAt);
  if (
    body.schema !== RECEIPT_SCHEMA ||
    body.keyId !== keyId ||
    typeof body.eventId !== "string" ||
    !EVENT_ID_PATTERN.test(body.eventId) ||
    !isSafeIntegerBetween(body.sequence, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerBetween(body.amountFen, 1, 100_000_000) ||
    body.currency !== "CNY" ||
    body.source !== "wechat-commercial" ||
    typeof body.messageFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(body.messageFingerprint) ||
    observedAt == null ||
    paidAt == null ||
    observedAt > currentTime + MAX_CLOCK_SKEW_SECONDS * 1000 ||
    paidAt > observedAt + 2 * 60 * 1000
  ) {
    throw new Error("INVALID_RECEIPT_EVENT");
  }
  return {
    eventId: body.eventId,
    keyId,
    sequence: body.sequence,
    messageFingerprint: body.messageFingerprint,
    amountFen: body.amountFen,
    paidAt,
    observedAt,
  };
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error("INVALID_MERCHANT_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_MERCHANT_JSON");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  body: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (
    Object.keys(body).length !== allowed.size ||
    Object.keys(body).some((key) => !allowed.has(key))
  ) {
    throw new Error("INVALID_MERCHANT_EVENT_FIELDS");
  }
}

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    return undefined;
  }
  return timestamp;
}

function isSafeIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
