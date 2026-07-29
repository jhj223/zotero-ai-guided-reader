import assert from "node:assert/strict";
import { createCipheriv, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { SandboxPaymentProvider } from "../src/payments/sandbox.js";
import {
  WechatNativeProvider,
  createWechatAuthorization,
  decryptWechatResource,
  verifyWechatMessage,
} from "../src/payments/wechatNative.js";

function rsaKeys() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("sandbox provider creates deterministic test checkout URLs", async () => {
  const provider = new SandboxPaymentProvider(
    "https://license.test",
    "sandbox-secret-with-at-least-32-bytes",
  );
  assert.deepEqual(
    await provider.createPayment({
      orderId: "order_123",
      amountFen: 1990,
      description: "AI 带读 Pro 月付",
      expiresAt: Date.UTC(2026, 6, 29, 13),
    }),
    {
      providerOrderId: "sandbox_order_123",
      codeUrl:
        "https://license.test/v1/sandbox/pay/order_123?proof=" +
        provider.createProof("order_123"),
    },
  );
  assert.equal(
    provider.verifyProof("order_123", provider.createProof("order_123")),
    true,
  );
  assert.equal(
    provider.verifyProof("order_456", provider.createProof("order_123")),
    false,
  );
});

test("creates a WeChat APIv3 authorization signature", () => {
  const merchant = rsaKeys();
  const authorization = createWechatAuthorization({
    method: "POST",
    canonicalUrl: "/v3/pay/transactions/native",
    body: '{"amount":{"total":1990}}',
    merchantId: "1900000001",
    merchantSerial: "SERIAL123",
    merchantPrivateKey: merchant.privateKey,
    timestamp: 1_722_258_000,
    nonce: "nonce-123",
  });

  assert.match(authorization, /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",/);
  const signature = /signature="([^"]+)"/.exec(authorization)?.[1];
  assert.ok(signature);
  assert.equal(
    verifyWechatMessage(
      [
        "POST",
        "/v3/pay/transactions/native",
        "1722258000",
        "nonce-123",
        '{"amount":{"total":1990}}',
        "",
      ].join("\n"),
      signature,
      merchant.publicKey,
    ),
    true,
  );
});

test("verifies callback signatures and rejects modified raw bodies", () => {
  const platform = rsaKeys();
  const timestamp = "1722258000";
  const nonce = "callback-nonce";
  const body = '{"id":"event-1"}';
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${body}\n`, "utf8");
  signer.end();
  const signature = signer.sign(platform.privateKey).toString("base64");

  assert.equal(
    verifyWechatMessage(
      `${timestamp}\n${nonce}\n${body}\n`,
      signature,
      platform.publicKey,
    ),
    true,
  );
  assert.equal(
    verifyWechatMessage(
      `${timestamp}\n${nonce}\n${body}x\n`,
      signature,
      platform.publicKey,
    ),
    false,
  );
});

test("decrypts APIv3 AES-256-GCM callback resources", () => {
  const apiV3Key = "12345678901234567890123456789012";
  const nonce = "123456789012";
  const associatedData = "transaction";
  const plaintext = JSON.stringify({
    mchid: "1900000001",
    out_trade_no: "order_1",
    transaction_id: "wx_1",
    trade_state: "SUCCESS",
    amount: { total: 1990, currency: "CNY" },
  });
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");

  assert.equal(
    decryptWechatResource({ ciphertext, nonce, associatedData }, apiV3Key),
    plaintext,
  );
  assert.throws(() =>
    decryptWechatResource(
      {
        ciphertext: `${ciphertext.slice(0, -2)}AA`,
        nonce,
        associatedData,
      },
      apiV3Key,
    ),
  );
});

test("direct Native provider signs the official order request and verifies the response", async () => {
  const merchant = rsaKeys();
  const platform = rsaKeys();
  const responseBody = JSON.stringify({
    code_url: "weixin://wxpay/bizpayurl?pr=test",
  });
  const responseTimestamp = "1722258001";
  const responseNonce = "response-nonce";
  const responseSigner = createSign("RSA-SHA256");
  responseSigner.update(
    `${responseTimestamp}\n${responseNonce}\n${responseBody}\n`,
    "utf8",
  );
  responseSigner.end();
  const responseSignature = responseSigner
    .sign(platform.privateKey)
    .toString("base64");
  let capturedBody = "";
  let capturedAuthorization = "";

  const provider = new WechatNativeProvider(
    {
      mode: "direct",
      merchantId: "1900000001",
      appId: "wx-app-1",
      merchantSerial: "MERCHANT-SERIAL",
      merchantPrivateKey: merchant.privateKey,
      apiV3Key: "12345678901234567890123456789012",
      notifyUrl: "https://license.test/v1/webhooks/wechat",
      platformPublicKeys: new Map([["PLATFORM-SERIAL", platform.publicKey]]),
    },
    async (_url, init) => {
      capturedBody = String(init?.body || "");
      capturedAuthorization = String(
        new Headers(init?.headers).get("Authorization") || "",
      );
      return new Response(responseBody, {
        status: 200,
        headers: {
          "Wechatpay-Timestamp": responseTimestamp,
          "Wechatpay-Nonce": responseNonce,
          "Wechatpay-Serial": "PLATFORM-SERIAL",
          "Wechatpay-Signature": responseSignature,
        },
      });
    },
    {
      nowSeconds: () => 1_722_258_000,
      nonce: () => "request-nonce",
    },
  );

  const payment = await provider.createPayment({
    orderId: "order_123456",
    amountFen: 1990,
    description: "AI 带读 Pro 月付",
    expiresAt: Date.UTC(2026, 6, 29, 13),
  });

  assert.equal(payment.codeUrl, "weixin://wxpay/bizpayurl?pr=test");
  assert.equal(payment.providerOrderId, "order_123456");
  assert.match(capturedAuthorization, /mchid="1900000001"/);
  assert.deepEqual(JSON.parse(capturedBody), {
    appid: "wx-app-1",
    mchid: "1900000001",
    description: "AI 带读 Pro 月付",
    out_trade_no: "order_123456",
    time_expire: "2026-07-29T13:00:00.000Z",
    notify_url: "https://license.test/v1/webhooks/wechat",
    amount: { total: 1990, currency: "CNY" },
  });
});

test("rejects a correctly signed but stale WeChat response", async () => {
  const merchant = rsaKeys();
  const platform = rsaKeys();
  const responseBody = JSON.stringify({
    code_url: "weixin://wxpay/bizpayurl?pr=test",
  });
  const staleTimestamp = "1722257699";
  const responseNonce = "response-nonce";
  const signer = createSign("RSA-SHA256");
  signer.update(
    `${staleTimestamp}\n${responseNonce}\n${responseBody}\n`,
    "utf8",
  );
  signer.end();
  const signature = signer.sign(platform.privateKey).toString("base64");
  const provider = new WechatNativeProvider(
    {
      mode: "direct",
      merchantId: "1900000001",
      appId: "wx-app-1",
      merchantSerial: "MERCHANT-SERIAL",
      merchantPrivateKey: merchant.privateKey,
      apiV3Key: "12345678901234567890123456789012",
      notifyUrl: "https://license.test/v1/webhooks/wechat",
      platformPublicKeys: new Map([["PLATFORM-SERIAL", platform.publicKey]]),
    },
    async () =>
      new Response(responseBody, {
        status: 200,
        headers: {
          "Wechatpay-Timestamp": staleTimestamp,
          "Wechatpay-Nonce": responseNonce,
          "Wechatpay-Serial": "PLATFORM-SERIAL",
          "Wechatpay-Signature": signature,
        },
      }),
    {
      nowSeconds: () => 1_722_258_000,
      nonce: () => "request-nonce",
    },
  );

  await assert.rejects(
    () =>
      provider.createPayment({
        orderId: "order_123456",
        amountFen: 1990,
        description: "AI Guided Reader Pro Monthly",
        expiresAt: Date.UTC(2026, 6, 29, 13),
      }),
    /timestamp/i,
  );
});
