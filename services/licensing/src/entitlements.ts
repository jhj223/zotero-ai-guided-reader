import { createSign, createVerify, type KeyLike } from "node:crypto";
import type { EntitlementRecord } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TYPE = "ZGAI-ENT";

export interface EntitlementClaims {
  version: 1;
  issuer: string;
  audience: string;
  tokenId: string;
  deviceId: string;
  kind: "trial" | "pro";
  planId: "trial" | "pro_monthly" | "pro_yearly";
  issuedAt: number;
  offlineUntil: number;
  validUntil: number;
}

export interface EntitlementSigningConfig {
  keyId: string;
  issuer: string;
  audience: string;
  randomTokenId: () => string;
}

export interface EntitlementVerificationConfig {
  publicKeys: ReadonlyMap<string, KeyLike>;
  issuer: string;
  audience: string;
}

export class EntitlementSigner {
  constructor(
    private readonly privateKey: KeyLike,
    private readonly publicKey: KeyLike,
    private readonly config: EntitlementSigningConfig,
  ) {
    const probe = "zotero-ai-guided-reader-key-pair-check";
    const signer = createSign("RSA-SHA256");
    signer.update(probe, "utf8");
    signer.end();
    const signature = signer.sign(this.privateKey);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(probe, "utf8");
    verifier.end();
    if (!verifier.verify(this.publicKey, signature)) {
      throw new Error("Entitlement signing key pair does not match.");
    }
  }

  sign(record: EntitlementRecord, issuedAt: number): string {
    const claims: EntitlementClaims = {
      version: 1,
      issuer: this.config.issuer,
      audience: this.config.audience,
      tokenId: this.config.randomTokenId(),
      deviceId: record.deviceId,
      kind: record.kind,
      planId: record.planId,
      issuedAt,
      offlineUntil: Math.min(record.validUntil, issuedAt + 30 * DAY_MS),
      validUntil: record.validUntil,
    };
    const header = encodeJson({
      alg: "RS256",
      typ: TOKEN_TYPE,
      kid: this.config.keyId,
    });
    const payload = encodeJson(claims);
    const signed = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signed, "utf8");
    signer.end();
    const signature = signer.sign(this.privateKey).toString("base64url");
    return `${signed}.${signature}`;
  }

  verify(token: string): EntitlementClaims {
    return verifyEntitlementToken(token, {
      publicKeys: new Map([[this.config.keyId, this.publicKey]]),
      issuer: this.config.issuer,
      audience: this.config.audience,
    });
  }
}

export function verifyEntitlementToken(
  token: string,
  config: EntitlementVerificationConfig,
): EntitlementClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("INVALID_TOKEN_FORMAT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader) as Record<string, unknown>;
  if (
    header.alg !== "RS256" ||
    header.typ !== TOKEN_TYPE ||
    typeof header.kid !== "string"
  ) {
    throw new Error("INVALID_TOKEN_HEADER");
  }
  const publicKey = config.publicKeys.get(header.kid);
  if (!publicKey) throw new Error("UNKNOWN_TOKEN_SIGNING_KEY");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`, "utf8");
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(encodedSignature, "base64url"))) {
    throw new Error("INVALID_TOKEN_SIGNATURE");
  }
  return validateClaims(decodeJson(encodedPayload), config);
}

function validateClaims(
  value: unknown,
  config: Pick<EntitlementVerificationConfig, "issuer" | "audience">,
): EntitlementClaims {
  if (!value || typeof value !== "object") {
    throw new Error("INVALID_TOKEN_CLAIMS");
  }
  const claims = value as Record<string, unknown>;
  if (
    claims.version !== 1 ||
    claims.issuer !== config.issuer ||
    claims.audience !== config.audience ||
    typeof claims.tokenId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(claims.tokenId) ||
    typeof claims.deviceId !== "string" ||
    !["trial", "pro"].includes(String(claims.kind)) ||
    !["trial", "pro_monthly", "pro_yearly"].includes(String(claims.planId)) ||
    !isFiniteNumber(claims.issuedAt) ||
    !isFiniteNumber(claims.offlineUntil) ||
    !isFiniteNumber(claims.validUntil) ||
    Number(claims.offlineUntil) > Number(claims.validUntil) ||
    Number(claims.issuedAt) > Number(claims.offlineUntil)
  ) {
    throw new Error("INVALID_TOKEN_CLAIMS");
  }
  return claims as unknown as EntitlementClaims;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_TOKEN_JSON");
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
