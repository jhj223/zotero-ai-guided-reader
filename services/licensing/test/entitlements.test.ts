import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  EntitlementSigner,
  verifyEntitlementToken,
} from "../src/entitlements.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 6, 29, 12);

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signer(keys: ReturnType<typeof keyPair>) {
  let tokenSequence = 0;
  return new EntitlementSigner(keys.privateKey, keys.publicKey, {
    keyId: "license-key-2026-07",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    randomTokenId: () => `entitlement-${++tokenSequence}`,
  });
}

test("signs an entitlement with an offline window bounded by paid expiry", () => {
  const keys = keyPair();
  const entitlementSigner = signer(keys);
  const token = entitlementSigner.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_yearly",
      validUntil: now + 365 * DAY_MS,
      updatedAt: now,
    },
    now,
  );

  const claims = verifyEntitlementToken(token, {
    publicKeys: new Map([["license-key-2026-07", keys.publicKey]]),
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
  });
  assert.equal(claims.deviceId, "device-1");
  assert.equal(claims.planId, "pro_yearly");
  assert.equal(claims.issuer, "https://license.example.test");
  assert.equal(claims.audience, "zotero-ai-guided-reader");
  assert.equal(claims.tokenId, "entitlement-1");
  assert.equal(claims.offlineUntil, now + 30 * DAY_MS);
  assert.equal(claims.validUntil, now + 365 * DAY_MS);
});

test("never extends the offline window past a monthly entitlement", () => {
  const keys = keyPair();
  const entitlementSigner = signer(keys);
  const token = entitlementSigner.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: now + 10 * DAY_MS,
      updatedAt: now,
    },
    now,
  );

  assert.equal(
    verifyEntitlementToken(token, {
      publicKeys: new Map([["license-key-2026-07", keys.publicKey]]),
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
    }).offlineUntil,
    now + 10 * DAY_MS,
  );
});

test("rejects a token whose payload was modified", () => {
  const keys = keyPair();
  const entitlementSigner = signer(keys);
  const token = entitlementSigner.sign(
    {
      deviceId: "device-1",
      kind: "trial",
      planId: "trial",
      validUntil: now + 7 * DAY_MS,
      updatedAt: now,
    },
    now,
  );
  const [header, payload, signature] = token.split(".");
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  decoded.validUntil = now + 365 * DAY_MS;
  const tampered = [
    header,
    Buffer.from(JSON.stringify(decoded)).toString("base64url"),
    signature,
  ].join(".");

  assert.throws(() =>
    verifyEntitlementToken(tampered, {
      publicKeys: new Map([["license-key-2026-07", keys.publicKey]]),
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
    }),
  );
});

test("rejects unknown signing keys and cross-product replay", () => {
  const keys = keyPair();
  const token = signer(keys).sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: now + 30 * DAY_MS,
      updatedAt: now,
    },
    now,
  );

  assert.throws(
    () =>
      verifyEntitlementToken(token, {
        publicKeys: new Map(),
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
      }),
    /unknown/i,
  );
  assert.throws(
    () =>
      verifyEntitlementToken(token, {
        publicKeys: new Map([["license-key-2026-07", keys.publicKey]]),
        issuer: "https://license.example.test",
        audience: "another-product",
      }),
    /claims/i,
  );
});

test("rejects a mismatched signing key pair at startup", () => {
  const privateKeys = keyPair();
  const publicKeys = keyPair();
  assert.throws(
    () =>
      new EntitlementSigner(privateKeys.privateKey, publicKeys.publicKey, {
        keyId: "license-key-2026-07",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        randomTokenId: () => "entitlement-test",
      }),
    /key pair/i,
  );
});
