import {
  entitlementState,
  type EntitlementState,
  type EntitlementClaims,
} from "./license";
import type { EntitlementPublicJwk } from "./licenseConfig";

const TOKEN_TYPE = "ZGAI-ENT";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface EntitlementVerificationOptions {
  deviceId: string;
  issuer: string;
  audience: string;
  now?: number;
}

export interface VerifiedEntitlement {
  claims: EntitlementClaims;
  state: EntitlementState;
}

export async function verifySignedEntitlement(
  token: string,
  publicKeys: Readonly<Record<string, EntitlementPublicJwk>>,
  options: EntitlementVerificationOptions,
): Promise<EntitlementClaims> {
  const verified = await verifySignedEntitlementState(
    token,
    publicKeys,
    options,
  );
  if (verified.state.status === "expired") {
    throw new Error("Entitlement has expired.");
  }
  if (verified.state.status === "refresh_required") {
    throw new Error("Entitlement refresh is required.");
  }
  if (!verified.state.canUsePro) throw new Error("Entitlement is invalid.");
  return verified.claims;
}

export async function verifySignedEntitlementState(
  token: string,
  publicKeys: Readonly<Record<string, EntitlementPublicJwk>>,
  options: EntitlementVerificationOptions,
): Promise<VerifiedEntitlement> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid entitlement token format.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJson(encodedHeader) as Record<string, unknown>;
  if (
    header.alg !== "RS256" ||
    header.typ !== TOKEN_TYPE ||
    typeof header.kid !== "string"
  ) {
    throw new Error("Invalid entitlement token header.");
  }
  const publicJwk = publicKeys[header.kid];
  if (!publicJwk) throw new Error("Unknown entitlement signing key.");
  const claims = validateClaims(
    parseJson(encodedPayload),
    options.issuer,
    options.audience,
  );
  const now = options.now ?? Date.now();
  if (claims.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throw new Error("Entitlement was issued too far in the future.");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...publicJwk, ext: true, key_ops: ["verify"] },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error("Entitlement signature is invalid.");
  if (claims.deviceId !== options.deviceId) {
    throw new Error("Entitlement device does not match this installation.");
  }

  const state = entitlementState(claims, options.deviceId, now);
  return { claims, state };
}

function validateClaims(
  value: unknown,
  expectedIssuer: string,
  expectedAudience: string,
): EntitlementClaims {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid entitlement claims.");
  }
  const claims = value as Record<string, unknown>;
  if (
    claims.version !== 1 ||
    claims.issuer !== expectedIssuer ||
    claims.audience !== expectedAudience ||
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
    throw new Error("Invalid entitlement claims.");
  }
  return claims as unknown as EntitlementClaims;
}

function parseJson(encoded: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encoded)),
    ) as unknown;
  } catch {
    throw new Error("Invalid entitlement token JSON.");
  }
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
