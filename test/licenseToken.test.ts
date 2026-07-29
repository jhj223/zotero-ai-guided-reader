import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { EntitlementSigner } from "../services/licensing/src/entitlements";
import { verifySignedEntitlement } from "../src/core/licenseToken";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 6, 29, 12);

function setup() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const publicPem = pair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  return {
    signer: new EntitlementSigner(privatePem, publicPem, {
      keyId: "license-key-2026-07",
      issuer: "https://license.example.test",
      audience: "zotero-ai-guided-reader",
      randomTokenId: () => "entitlement-1",
    }),
    publicKeys: { "license-key-2026-07": publicJwk },
  };
}

test("verifies a service-signed entitlement in the WebCrypto client", async () => {
  const { signer, publicKeys } = setup();
  const token = signer.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: now + 30 * DAY_MS,
      updatedAt: now,
    },
    now,
  );

  const claims = await verifySignedEntitlement(token, publicKeys, {
    deviceId: "device-1",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    now,
  });
  assert.equal(claims.planId, "pro_monthly");
});

test("rejects signatures and device IDs that do not match", async () => {
  const first = setup();
  const second = setup();
  const token = first.signer.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_yearly",
      validUntil: now + 365 * DAY_MS,
      updatedAt: now,
    },
    now,
  );

  await assert.rejects(
    () =>
      verifySignedEntitlement(token, second.publicKeys, {
        deviceId: "device-1",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /signature/i,
  );
  await assert.rejects(
    () =>
      verifySignedEntitlement(token, first.publicKeys, {
        deviceId: "device-2",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /device/i,
  );
});

test("rejects expired and refresh-required signed entitlements", async () => {
  const { signer, publicKeys } = setup();
  const expired = signer.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: now - 1,
      updatedAt: now - 40 * DAY_MS,
    },
    now - 40 * DAY_MS,
  );
  const stale = signer.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_yearly",
      validUntil: now + 300 * DAY_MS,
      updatedAt: now - 40 * DAY_MS,
    },
    now - 40 * DAY_MS,
  );

  await assert.rejects(
    () =>
      verifySignedEntitlement(expired, publicKeys, {
        deviceId: "device-1",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /expired/i,
  );
  await assert.rejects(
    () =>
      verifySignedEntitlement(stale, publicKeys, {
        deviceId: "device-1",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /refresh/i,
  );
});

test("rejects unknown signing keys, wrong issuer, and future-issued tokens", async () => {
  const { signer, publicKeys } = setup();
  const token = signer.sign(
    {
      deviceId: "device-1",
      kind: "pro",
      planId: "pro_monthly",
      validUntil: now + 30 * DAY_MS,
      updatedAt: now,
    },
    now + 10 * 60 * 1000,
  );

  await assert.rejects(
    () =>
      verifySignedEntitlement(
        token,
        {},
        {
          deviceId: "device-1",
          issuer: "https://license.example.test",
          audience: "zotero-ai-guided-reader",
          now,
        },
      ),
    /unknown/i,
  );
  await assert.rejects(
    () =>
      verifySignedEntitlement(token, publicKeys, {
        deviceId: "device-1",
        issuer: "https://other.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /claims/i,
  );
  await assert.rejects(
    () =>
      verifySignedEntitlement(token, publicKeys, {
        deviceId: "device-1",
        issuer: "https://license.example.test",
        audience: "zotero-ai-guided-reader",
        now,
      }),
    /future/i,
  );
});
