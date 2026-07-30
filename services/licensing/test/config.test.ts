import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads development sandbox config with server-owned prices", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    SANDBOX_SECRET: "sandbox-secret-with-at-least-32-bytes",
    LICENSE_PRIVATE_KEY_PATH: "private.pem",
    LICENSE_PUBLIC_KEY_PATH: "public.pem",
  });

  assert.equal(config.paymentProvider, "sandbox");
  assert.equal(config.monthlyPriceFen, 1990);
  assert.equal(config.yearlyPriceFen, 19900);
  assert.equal(config.port, 8787);
  assert.equal(
    config.sourceUrl,
    "https://github.com/jhj223/zotero-ai-guided-reader",
  );
});

test("rejects unsafe entitlement key and audience identifiers", () => {
  const base = {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    SANDBOX_SECRET: "sandbox-secret-with-at-least-32-bytes",
  };
  assert.throws(
    () => loadConfig({ ...base, ENTITLEMENT_KEY_ID: "bad key id" }),
    /ENTITLEMENT_KEY_ID/,
  );
  assert.throws(
    () => loadConfig({ ...base, ENTITLEMENT_AUDIENCE: "../other" }),
    /ENTITLEMENT_AUDIENCE/,
  );
});

test("requires HTTPS and forbids sandbox payments in production", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_PATH: "D:/data/licensing.sqlite",
    LICENSE_PRIVATE_KEY_PATH: "D:/secrets/private.pem",
    LICENSE_PUBLIC_KEY_PATH: "D:/secrets/public.pem",
    ENTITLEMENT_ISSUER: "https://license.example.com",
    PUBLIC_BASE_URL: "https://license.example.com",
    SOURCE_URL: "https://github.com/example/licensing-source",
  };

  assert.throws(
    () =>
      loadConfig({
        ...base,
        PAYMENT_PROVIDER: "sandbox",
        SANDBOX_SECRET: "sandbox-secret-with-at-least-32-bytes",
      }),
    /sandbox/i,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PUBLIC_BASE_URL: "http://license.example.com",
        PAYMENT_PROVIDER: "wechat-native",
      }),
    /https/i,
  );
});

test("requires an HTTPS corresponding-source URL in production", () => {
  const base = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "wechat-native",
    DATABASE_PATH: "D:/data/licensing.sqlite",
    LICENSE_PRIVATE_KEY_PATH: "D:/secrets/private.pem",
    LICENSE_PUBLIC_KEY_PATH: "D:/secrets/public.pem",
    ENTITLEMENT_ISSUER: "https://license.example.com",
    PUBLIC_BASE_URL: "https://license.example.com",
    WECHAT_MERCHANT_ID: "1900000001",
    WECHAT_APP_ID: "wx-app-1",
    WECHAT_MERCHANT_SERIAL: "SERIAL",
    WECHAT_MERCHANT_PRIVATE_KEY_PATH: "D:/secrets/wechat.pem",
    WECHAT_API_V3_KEY: "12345678901234567890123456789012",
    WECHAT_PLATFORM_KEYS_JSON: '{"PLATFORM-SERIAL":"D:/secrets/platform.pem"}',
  };
  assert.throws(() => loadConfig(base), /SOURCE_URL/);
  assert.throws(
    () => loadConfig({ ...base, SOURCE_URL: "http://source.example.com" }),
    /HTTPS/i,
  );
});

test("validates WeChat Native secrets and price overrides", () => {
  const common = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "wechat-native",
    DATABASE_PATH: "D:/data/licensing.sqlite",
    LICENSE_PRIVATE_KEY_PATH: "D:/secrets/private.pem",
    LICENSE_PUBLIC_KEY_PATH: "D:/secrets/public.pem",
    ENTITLEMENT_ISSUER: "https://license.example.com",
    PUBLIC_BASE_URL: "https://license.example.com",
    SOURCE_URL: "https://github.com/example/licensing-source",
    WECHAT_MERCHANT_ID: "1900000001",
    WECHAT_APP_ID: "wx-app-1",
    WECHAT_MERCHANT_SERIAL: "SERIAL",
    WECHAT_MERCHANT_PRIVATE_KEY_PATH: "D:/secrets/wechat.pem",
    WECHAT_PLATFORM_KEYS_JSON: '{"PLATFORM-SERIAL":"D:/secrets/platform.pem"}',
  };

  assert.throws(
    () => loadConfig({ ...common, WECHAT_API_V3_KEY: "short" }),
    /32 bytes/i,
  );
  const config = loadConfig({
    ...common,
    WECHAT_API_V3_KEY: "12345678901234567890123456789012",
    MONTHLY_PRICE_FEN: "2990",
    YEARLY_PRICE_FEN: "29900",
  });
  assert.equal(config.paymentProvider, "wechat-native");
  assert.equal(config.monthlyPriceFen, 2990);
  assert.equal(config.yearlyPriceFen, 29900);
});

test("loads static QR config with strict watcher public-key paths", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "wechat-static-qr",
    DATABASE_PATH: "D:/data/licensing.sqlite",
    LICENSE_PRIVATE_KEY_PATH: "D:/secrets/private.pem",
    LICENSE_PUBLIC_KEY_PATH: "D:/secrets/public.pem",
    ENTITLEMENT_ISSUER: "https://license.example.com",
    PUBLIC_BASE_URL: "https://license.example.com",
    SOURCE_URL: "https://github.com/example/licensing-source",
    WECHAT_STATIC_QR_IMAGE_PATH: "D:/secrets/wechat-qr.png",
    RECEIPT_WATCHER_KEYS_JSON:
      '{"merchant-pc-01":"D:/secrets/merchant-pc-01.pub.pem"}',
  });

  assert.equal(config.paymentProvider, "wechat-static-qr");
  assert.equal(config.staticQr.imagePath, "D:/secrets/wechat-qr.png");
  assert.deepEqual(config.staticQr.watcherPublicKeyPaths, {
    "merchant-pc-01": "D:/secrets/merchant-pc-01.pub.pem",
  });
});

test("rejects missing or malformed static QR watcher configuration", () => {
  const common = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "wechat-static-qr",
    DATABASE_PATH: "D:/data/licensing.sqlite",
    LICENSE_PRIVATE_KEY_PATH: "D:/secrets/private.pem",
    LICENSE_PUBLIC_KEY_PATH: "D:/secrets/public.pem",
    ENTITLEMENT_ISSUER: "https://license.example.com",
    PUBLIC_BASE_URL: "https://license.example.com",
    SOURCE_URL: "https://github.com/example/licensing-source",
    WECHAT_STATIC_QR_IMAGE_PATH: "D:/secrets/wechat-qr.png",
  };

  assert.throws(() => loadConfig(common), /RECEIPT_WATCHER_KEYS_JSON/);
  assert.throws(
    () =>
      loadConfig({
        ...common,
        RECEIPT_WATCHER_KEYS_JSON: '{"bad key":"D:/secrets/key.pem"}',
      }),
    /RECEIPT_WATCHER_KEYS_JSON/,
  );
});
