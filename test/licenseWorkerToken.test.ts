import assert from "node:assert/strict";
import test from "node:test";
import type { EntitlementPublicJwk } from "../src/core/licenseConfig";
import { verifySignedEntitlement } from "../src/core/licenseToken";
import {
  pemFromDer,
  signEntitlement,
} from "../services/licensing-worker/src/crypto";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 7, 11, 8);

test("accepts a Worker-issued entitlement in the Zotero client verifier", async () => {
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
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as EntitlementPublicJwk;
  const token = await signEntitlement(
    {
      deviceId: "device_worker_001",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: NOW + 30 * DAY_MS,
      updatedAt: NOW,
    },
    NOW,
    {
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
      keyId: "license-key-worker-test",
      privateKeyPem: pemFromDer(privateDer, "PRIVATE KEY"),
    },
  );

  const claims = await verifySignedEntitlement(
    token,
    { "license-key-worker-test": publicJwk },
    {
      deviceId: "device_worker_001",
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
      now: NOW,
    },
  );

  assert.equal(claims.planId, "pro_monthly");
  assert.equal(claims.offlineUntil, NOW + 30 * DAY_MS);
});
