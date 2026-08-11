import type { EntitlementRecord } from "./store";
import {
  createPrivateKey,
  createPublicKey,
  createVerify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

const DAY_MS = 86_400_000;

export interface EntitlementSigningConfig {
  issuer: string;
  audience: string;
  keyId: string;
  privateKeyPem: string;
  verificationKeys?: Readonly<Record<string, JsonWebKey>>;
}

export interface RefreshTokenClaims {
  deviceId: string;
  issuer: string;
  audience: string;
  issuedAt: number;
  offlineUntil: number;
  validUntil: number;
}

export function randomOpaqueId(prefix: string): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `${prefix}_${encodeBase64Url(bytes)}`;
}

export async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function signEntitlement(
  record: EntitlementRecord,
  issuedAt: number,
  config: EntitlementSigningConfig,
): Promise<string> {
  const header = encodeJson({
    alg: "RS256",
    typ: "ZGAI-ENT",
    kid: config.keyId,
  });
  const plannedOfflineUntil = Math.min(
    record.validUntil - DAY_MS,
    issuedAt + 30 * DAY_MS,
  );
  const offlineUntil =
    plannedOfflineUntil > issuedAt ? plannedOfflineUntil : record.validUntil;
  const payload = encodeJson({
    version: 1,
    issuer: config.issuer,
    audience: config.audience,
    tokenId: randomOpaqueId("ent"),
    deviceId: record.deviceId,
    kind: record.kind,
    planId: record.planId,
    issuedAt,
    offlineUntil,
    validUntil: record.validUntil,
  });
  const signed = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    derFromPem(config.privateKeyPem, "PRIVATE KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export function verifyRefreshToken(
  token: string,
  expectedDeviceId: string,
  config: EntitlementSigningConfig,
): RefreshTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("INVALID_ENTITLEMENT_TOKEN");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedPayload);
  const headerValues =
    header && typeof header === "object" && !Array.isArray(header)
      ? (header as Record<string, unknown>)
      : undefined;
  if (
    !headerValues ||
    headerValues.alg !== "RS256" ||
    headerValues.typ !== "ZGAI-ENT" ||
    typeof headerValues.kid !== "string" ||
    !/^[A-Za-z0-9._-]{3,128}$/.test(headerValues.kid) ||
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims)
  ) {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
  const values = claims as Record<string, unknown>;
  if (
    values.version !== 1 ||
    values.deviceId !== expectedDeviceId ||
    values.issuer !== config.issuer ||
    values.audience !== config.audience ||
    typeof values.tokenId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(values.tokenId) ||
    (values.kind !== "trial" && values.kind !== "pro") ||
    (values.planId !== "trial" &&
      values.planId !== "pro_monthly" &&
      values.planId !== "pro_yearly") ||
    (values.kind === "trial" && values.planId !== "trial") ||
    (values.kind === "pro" && values.planId === "trial") ||
    !validTimestamp(values.issuedAt) ||
    !validTimestamp(values.offlineUntil) ||
    !validTimestamp(values.validUntil) ||
    values.issuedAt > values.offlineUntil ||
    values.offlineUntil > values.validUntil
  ) {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`, "utf8");
  verifier.end();
  const publicKey =
    headerValues.kid === config.keyId
      ? createPublicKey(createPrivateKey(config.privateKeyPem))
      : publicKeyFromRing(headerValues.kid, config.verificationKeys);
  if (!verifier.verify(publicKey, base64UrlToBytes(encodedSignature))) {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
  return {
    deviceId: expectedDeviceId,
    issuer: config.issuer,
    audience: config.audience,
    issuedAt: values.issuedAt,
    offlineUntil: values.offlineUntil,
    validUntil: values.validUntil,
  };
}

function publicKeyFromRing(
  keyId: string,
  verificationKeys?: Readonly<Record<string, JsonWebKey>>,
) {
  const jwk = verificationKeys?.[keyId];
  if (!jwk) throw new Error("INVALID_ENTITLEMENT_TOKEN");
  try {
    return createPublicKey({ key: jwk as NodeJsonWebKey, format: "jwk" });
  } catch {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function pemFromDer(
  der: ArrayBuffer,
  label: "PRIVATE KEY" | "PUBLIC KEY",
): string {
  const base64 = bytesToBase64(new Uint8Array(der));
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function derFromPem(pem: string, label: "PRIVATE KEY"): ArrayBuffer {
  const match = pem
    .trim()
    .match(
      new RegExp(
        `^-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----$`,
      ),
    );
  if (!match) throw new Error("Entitlement private key is invalid.");
  const binary = atob(match[1].replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(value)),
    ) as unknown;
  } catch {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("INVALID_ENTITLEMENT_TOKEN");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
