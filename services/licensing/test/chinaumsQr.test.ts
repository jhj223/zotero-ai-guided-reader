import assert from "node:assert/strict";
import test from "node:test";
import { createChinaumsAuthorization } from "../src/payments/chinaumsAuth.js";
import { ChinaumsQrProvider } from "../src/payments/chinaumsQr.js";

const now = Date.UTC(2026, 7, 10, 12, 34, 56, 789);

test("ChinaUMS QR creates a signed one-time bill at the fixed test host", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = new ChinaumsQrProvider(
    {
      environment: "test",
      appId: "app-id-123",
      appKey: "application-secret-value",
      merchantId: "898201612345678",
      terminalId: "88880001",
      messageSourceId: "AB12",
      notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
    },
    (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          errCode: "SUCCESS",
          errMsg: "ok",
          responseTimeStamp: "2026-08-10 20:34:57",
          billQRCode: "https://qr-test2.chinaums.com/bills/qrCode.do?id=qr_123",
          mid: "898201612345678",
          tid: "88880001",
          instMid: "QRPAYDEFAULT",
          billNo: "AB12202608102034567890000001",
          billDate: "2026-08-10",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
    {
      now: () => now,
      nonce: () => "nonce_123",
      randomDigits: () => "0000001",
    },
  );

  const payment = await provider.createPayment({
    orderId: "order_local_123",
    amountFen: 1990,
    description: "AI 带读 Pro 月付",
    expiresAt: now + 15 * 60 * 1000,
  });

  assert.deepEqual(payment, {
    providerOrderId: "AB12202608102034567890000001",
    codeUrl: "https://qr-test2.chinaums.com/bills/qrCode.do?id=qr_123",
  });
  assert.equal(
    capturedUrl,
    "https://test-api-open.chinaums.com/v1/netpay/bills/get-qrcode",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const body = String(capturedInit?.body);
  assert.deepEqual(JSON.parse(body), {
    requestTimestamp: "2026-08-10 20:34:56",
    mid: "898201612345678",
    tid: "88880001",
    instMid: "QRPAYDEFAULT",
    billNo: "AB12202608102034567890000001",
    billDate: "2026-08-10",
    billDesc: "AI 带读 Pro 月付",
    totalAmount: 1990,
    expireTime: "2026-08-10 20:49:56",
    notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
    walletOption: "MULTIPLE",
  });
  const headers = new Headers(capturedInit?.headers);
  assert.equal(
    headers.get("Authorization"),
    createChinaumsAuthorization({
      appId: "app-id-123",
      appKey: "application-secret-value",
      timestamp: "20260810203456",
      nonce: "nonce_123",
      body,
    }),
  );
});

test("ChinaUMS QR rejects mismatched responses and untrusted QR hosts", async () => {
  const createProvider = (payload: Record<string, unknown>) =>
    new ChinaumsQrProvider(
      {
        environment: "production",
        appId: "app-id-123",
        appKey: "application-secret-value",
        merchantId: "898201612345678",
        terminalId: "88880001",
        messageSourceId: "AB12",
        notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
      },
      (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      {
        now: () => now,
        nonce: () => "nonce_123",
        randomDigits: () => "0000001",
      },
    );
  const valid = {
    errCode: "SUCCESS",
    billQRCode: "https://qr.chinaums.com/bills/qrCode.do?id=qr_123",
    mid: "898201612345678",
    tid: "88880001",
    instMid: "QRPAYDEFAULT",
    billNo: "AB12202608102034567890000001",
    billDate: "2026-08-10",
  };
  const input = {
    orderId: "order_local_123",
    amountFen: 1990,
    description: "monthly",
    expiresAt: now + 15 * 60 * 1000,
  };

  await assert.rejects(
    createProvider({ ...valid, mid: "898201612345679" }).createPayment(input),
    /merchant/i,
  );
  await assert.rejects(
    createProvider({
      ...valid,
      billQRCode: "https://attacker.example/bills/qrCode.do?id=qr_123",
    }).createPayment(input),
    /QR code URL/i,
  );
});

test("ChinaUMS QR accepts provider-owned redirect paths without weakening the host boundary", async () => {
  const provider = new ChinaumsQrProvider(
    {
      environment: "test",
      appId: "app-id-123",
      appKey: "application-secret-value",
      merchantId: "898201612345678",
      terminalId: "88880001",
      messageSourceId: "AB12",
      notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
    },
    (async () =>
      new Response(
        JSON.stringify({
          errCode: "SUCCESS",
          billQRCode:
            "https://qr-test2.chinaums.com/netpay/redirect?token=qr_123",
          mid: "898201612345678",
          tid: "88880001",
          instMid: "QRPAYDEFAULT",
          billNo: "AB12202608102034567890000001",
          billDate: "2026-08-10",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch,
    {
      now: () => now,
      nonce: () => "nonce_123",
      randomDigits: () => "0000001",
    },
  );

  const payment = await provider.createPayment({
    orderId: "order_local_123",
    amountFen: 1990,
    description: "monthly",
    expiresAt: now + 15 * 60 * 1000,
  });

  assert.equal(
    payment.codeUrl,
    "https://qr-test2.chinaums.com/netpay/redirect?token=qr_123",
  );
});

test("ChinaUMS QR queries a paid bill with the same authenticated channel", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = new ChinaumsQrProvider(
    {
      environment: "test",
      appId: "app-id-123",
      appKey: "application-secret-value",
      merchantId: "898201612345678",
      terminalId: "88880001",
      messageSourceId: "AB12",
      notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
    },
    (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          errCode: "SUCCESS",
          mid: "898201612345678",
          tid: "88880001",
          instMid: "QRPAYDEFAULT",
          billNo: "AB12202608102034567890000001",
          billDate: "2026-08-10",
          billStatus: "PAID",
          totalAmount: 1990,
          billPayment: {
            paySeqId: "00684900520N",
            payTime: "2026-08-10 20:35:00",
            status: "TRADE_SUCCESS",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
    {
      now: () => now,
      nonce: () => "query_nonce_123",
      randomDigits: () => "0000001",
    },
  );

  const result = await provider.queryPayment("AB12202608102034567890000001");

  assert.equal(
    capturedUrl,
    "https://test-api-open.chinaums.com/v1/netpay/bills/query",
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    requestTimestamp: "2026-08-10 20:34:56",
    mid: "898201612345678",
    tid: "88880001",
    instMid: "QRPAYDEFAULT",
    billNo: "AB12202608102034567890000001",
    billDate: "2026-08-10",
  });
  assert.equal(result.status, "paid");
  if (result.status === "paid") {
    assert.match(result.eventId, /^chinaums_query_[A-Za-z0-9_-]+$/);
    assert.equal(result.transactionId, "chinaums_00684900520N");
    assert.equal(result.amountFen, 1990);
    assert.equal(result.paidAt, Date.UTC(2026, 7, 10, 12, 35));
  }
});

test("ChinaUMS QR treats every non-paid query state as pending and rejects false paid data", async () => {
  const createProvider = (payload: Record<string, unknown>) =>
    new ChinaumsQrProvider(
      {
        environment: "production",
        appId: "app-id-123",
        appKey: "application-secret-value",
        merchantId: "898201612345678",
        terminalId: "88880001",
        messageSourceId: "AB12",
        notifyUrl: "https://license.example.com/v1/webhooks/chinaums",
      },
      (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
      {
        now: () => now,
        nonce: () => "query_nonce_123",
        randomDigits: () => "0000001",
      },
    );
  const echoed = {
    errCode: "SUCCESS",
    mid: "898201612345678",
    tid: "88880001",
    instMid: "QRPAYDEFAULT",
    billNo: "AB12202608102034567890000001",
    billDate: "2026-08-10",
    totalAmount: 1990,
  };

  assert.deepEqual(
    await createProvider({ ...echoed, billStatus: "UNPAID" }).queryPayment(
      echoed.billNo,
    ),
    { status: "pending" },
  );
  assert.deepEqual(
    await createProvider({ ...echoed, billStatus: "PART_REFUND" }).queryPayment(
      echoed.billNo,
    ),
    { status: "pending" },
  );
  await assert.rejects(
    createProvider({
      ...echoed,
      billStatus: "PAID",
      billPayment: {
        paySeqId: "00684900520N",
        payTime: "2026-08-10 20:35:00",
        status: "WAIT_BUYER_PAY",
      },
    }).queryPayment(echoed.billNo),
    /successful/i,
  );
});
