import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBundledLicenseConfig } from "../src/core/licenseConfig";

const publicJwk: JsonWebKey = {
  kty: "RSA",
  n: "test-modulus",
  e: "AQAB",
  alg: "RS256",
};

test("disables commercial actions when no production authority is bundled", () => {
  assert.deepEqual(
    normalizeBundledLicenseConfig({
      baseUrl: "",
      issuer: "",
      audience: "zotero-ai-guided-reader",
      publicKeys: {},
      development: false,
    }),
    {
      enabled: false,
      reason: "当前构建未配置官方授权服务。",
    },
  );
});

test("accepts pinned HTTPS authority and signing key ring", () => {
  assert.deepEqual(
    normalizeBundledLicenseConfig({
      baseUrl: "https://license.example.com/",
      issuer: "https://license.example.com/",
      audience: "zotero-ai-guided-reader",
      publicKeys: { "license-key-2026-07": publicJwk },
      development: false,
    }),
    {
      enabled: true,
      baseUrl: "https://license.example.com",
      issuer: "https://license.example.com",
      audience: "zotero-ai-guided-reader",
      publicKeys: { "license-key-2026-07": publicJwk },
      allowLoopbackHttp: false,
    },
  );
});

test("allows loopback HTTP only in development", () => {
  assert.equal(
    normalizeBundledLicenseConfig({
      baseUrl: "http://127.0.0.1:8787",
      issuer: "http://127.0.0.1:8787",
      audience: "zotero-ai-guided-reader",
      publicKeys: { "license-key-2026-07": publicJwk },
      development: true,
    }).enabled,
    true,
  );
  assert.throws(
    () =>
      normalizeBundledLicenseConfig({
        baseUrl: "http://127.0.0.1:8787",
        issuer: "http://127.0.0.1:8787",
        audience: "zotero-ai-guided-reader",
        publicKeys: { "license-key-2026-07": publicJwk },
        development: false,
      }),
    /HTTPS/i,
  );
});
