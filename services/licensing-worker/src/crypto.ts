import type { EntitlementRecord } from "./store";

const DAY_MS = 86_400_000;

export interface EntitlementSigningConfig {
  issuer: string;
  audience: string;
  keyId: string;
  privateKeyPem: string;
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
  const payload = encodeJson({
    version: 1,
    issuer: config.issuer,
    audience: config.audience,
    tokenId: randomOpaqueId("ent"),
    deviceId: record.deviceId,
    kind: record.kind,
    planId: record.planId,
    issuedAt,
    offlineUntil: Math.min(record.validUntil, issuedAt + 30 * DAY_MS),
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

export function pemFromDer(
  der: ArrayBuffer,
  label: "PRIVATE KEY" | "PUBLIC KEY",
): string {
  const base64 = bytesToBase64(new Uint8Array(der));
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function derFromPem(pem: string, label: "PRIVATE KEY"): ArrayBuffer {
  const match = pem.trim().match(
    new RegExp(`^-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----$`),
  );
  if (!match) throw new Error("Entitlement private key is invalid.");
  const binary = atob(match[1].replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
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
