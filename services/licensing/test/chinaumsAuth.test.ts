import assert from "node:assert/strict";
import test from "node:test";
import {
  createChinaumsAuthorization,
  createChinaumsBodySignature,
} from "../src/payments/chinaumsAuth.js";

test("ChinaUMS auth reproduces the official OPEN-BODY-SIG example", () => {
  const input = {
    appId: "12345678901234567890123456789012",
    appKey: "67890123456789012345678901234567",
    timestamp: "20170101120000",
    nonce: "09876543210987654321098765432109",
    body: "A",
  };

  assert.equal(
    createChinaumsBodySignature(input),
    "GINsCTyNKTpEI9KXO16KqZJ64fOyAytEKl8aaR/Dy08=",
  );
  assert.equal(
    createChinaumsAuthorization(input),
    'OPEN-BODY-SIG AppId="12345678901234567890123456789012",' +
      'Timestamp="20170101120000",' +
      'Nonce="09876543210987654321098765432109",' +
      'Signature="GINsCTyNKTpEI9KXO16KqZJ64fOyAytEKl8aaR/Dy08="',
  );
});

test("ChinaUMS auth signs the exact UTF-8 request bytes", () => {
  const common = {
    appId: "app_123",
    appKey: "application-secret",
    timestamp: "20260810123456",
    nonce: "nonce_123",
  };

  assert.notEqual(
    createChinaumsBodySignature({ ...common, body: '{"amount":1}' }),
    createChinaumsBodySignature({ ...common, body: '{"amount":1 }' }),
  );
  assert.throws(
    () =>
      createChinaumsAuthorization({
        ...common,
        appId: 'bad"app',
        body: "{}",
      }),
    /AppId/,
  );
});
