import { describe, expect, it } from "vitest";
import { pemFromDer, signEntitlement } from "../src/crypto";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 11, 8);

describe("Worker entitlement signing", () => {
  it("issues the existing ZGAI-ENT token format accepted by the plugin", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const token = await signEntitlement(
      {
        deviceId: "device_token_001",
        kind: "pro",
        planId: "pro_yearly",
        validUntil: NOW + 365 * DAY_MS,
        updatedAt: NOW,
      },
      NOW,
      {
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        keyId: "license-key-2026-08",
        privateKeyPem: pemFromDer(privateDer, "PRIVATE KEY"),
      },
    );

    const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedClaims)),
    ) as Record<string, unknown>;

    expect(valid).toBe(true);
    expect(claims.planId).toBe("pro_yearly");
    expect(claims.offlineUntil).toBe(NOW + 30 * DAY_MS);
    expect(JSON.parse(atob(encodedHeader))).toEqual({
      alg: "RS256",
      typ: "ZGAI-ENT",
      kid: "license-key-2026-08",
    });
  });
});

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
