# ChinaUMS QR Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, tested ChinaUMS one-time bill QR provider with signed callbacks and bill-query recovery to the existing licensing service.

**Architecture:** A provider owns fixed-host ChinaUMS HTTP calls and `OPEN-BODY-SIG` authentication. SQLite stores the external `billNo`; a dedicated callback processor validates the provider form signature and forwards only verified payments to the existing atomic entitlement path. Pending-order polling invokes a throttled bill query as recovery for missed callbacks.

**Tech Stack:** Node.js 24, TypeScript 5.9, `node:http`, `node:crypto`, `node:sqlite`, Node test runner, existing QRCode and entitlement service.

---

## File Map

- Create `services/licensing/src/payments/chinaumsAuth.ts`: official request and notification signature primitives.
- Create `services/licensing/src/payments/chinaumsQr.ts`: bill number generation, QR creation and bill query client.
- Create `services/licensing/src/payments/chinaumsWebhook.ts`: strict form parsing, signature verification and payment conversion.
- Modify `services/licensing/src/payments/provider.ts`: add `chinaums-qr` provider kind.
- Modify `services/licensing/src/config.ts`: parse strict ChinaUMS credentials without logging them.
- Modify `services/licensing/src/database.ts`: migrate/store unique `provider_order_id` and look orders up by it.
- Modify `services/licensing/src/domain.ts`: expose one-time external-order binding and lookup.
- Modify `services/licensing/src/server.ts`: bind returned bill numbers, process callbacks and query pending bills with throttling.
- Modify `services/licensing/src/main.ts`: construct the provider and callback processor.
- Add `services/licensing/test/chinaumsAuth.test.ts`, `chinaumsQr.test.ts`, `chinaumsWebhook.test.ts`, and `chinaumsServer.test.ts`.
- Modify `.env.example` and `services/licensing/README.md`: document placeholders and the merchant-onboarding boundary.

### Task 1: Authentication, Configuration, and Provider Contract

**Files:**

- Create: `services/licensing/src/payments/chinaumsAuth.ts`
- Modify: `services/licensing/src/payments/provider.ts`
- Modify: `services/licensing/src/config.ts`
- Test: `services/licensing/test/chinaumsAuth.test.ts`
- Test: `services/licensing/test/config.test.ts`

- [ ] **Step 1: Write failing authentication and configuration tests**

Test the official formula and strict provider selection:

```ts
assert.equal(
  createChinaumsBodySignature({
    appId,
    appKey,
    timestamp: "20170101120000",
    nonce: "09876543210987654321098765432109",
    body: "A",
  }),
  "GINsCTyNKTpEI9KXO16KqZJ64fOyAytEKl8aaR/Dy08=",
);

const config = loadConfig({
  ...productionBase,
  PAYMENT_PROVIDER: "chinaums-qr",
  CHINAUMS_APP_ID: "app-id",
  CHINAUMS_APP_KEY: "32-byte-placeholder-app-key-value",
  CHINAUMS_MID: "898201612345678",
  CHINAUMS_TID: "88880001",
  CHINAUMS_MSG_SRC_ID: "AB12",
  CHINAUMS_NOTIFY_KEY: "32-byte-placeholder-notify-key-val",
});
assert.equal(config.paymentProvider, "chinaums-qr");
```

- [ ] **Step 2: Run focused tests and observe the expected missing-export failures**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS auth|ChinaUMS config"`

Expected: FAIL because the provider kind, config branch and signing function do not exist.

- [ ] **Step 3: Implement the minimal signature helper and strict config union**

Implement exactly:

```ts
const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
return createHmac("sha256", appKey)
  .update(appId + timestamp + nonce + bodyHash, "utf8")
  .digest("base64");
```

The header formatter must quote fields and reject characters outside conservative AppId/nonce patterns. Config requires separate `appKey` and `notifyKey`, exact 15-digit `mid`, exact 8-character `tid`, and 4-character alphanumeric `msgSrcId`.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS auth|ChinaUMS config"`

Expected: the focused tests PASS.

### Task 2: QR Creation and External Bill Mapping

**Files:**

- Create: `services/licensing/src/payments/chinaumsQr.ts`
- Modify: `services/licensing/src/database.ts`
- Modify: `services/licensing/src/domain.ts`
- Test: `services/licensing/test/chinaumsQr.test.ts`
- Test: `services/licensing/test/domain.test.ts`

- [ ] **Step 1: Write failing provider and mapping tests**

Use an injected `fetch` and deterministic clock/random source. Assert that the request uses the expected fixed URL, authorization header, one-time-bill fields and amount. Assert valid response maps to:

```ts
{
  providerOrderId: "AB122026081012345670000001",
  codeUrl: "https://qr-test2.chinaums.com/bills/qrCode.do?id=...",
}
```

Add database tests proving `bindProviderOrderId(localId, billNo)` is one-time and unique, survives reload, and `findOrderByProviderOrderId` returns the local order.

- [ ] **Step 2: Run focused tests and observe failures**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS QR|provider order"`

Expected: FAIL because the provider and mapping APIs are absent.

- [ ] **Step 3: Implement fixed-host HTTP and the database migration**

Provider behavior:

```ts
const request = {
  requestTimestamp: formatChinaumsDateTime(now),
  mid,
  tid,
  instMid: "QRPAYDEFAULT",
  billNo,
  billDate: formatChinaumsDate(now),
  billDesc: description.slice(0, 128),
  totalAmount: amountFen,
  expireTime: formatChinaumsDateTime(expiresAt),
  notifyUrl,
  walletOption: "MULTIPLE",
};
```

Use `redirect: "error"`, a 10-second timeout and a 64 KiB response limit. Accept only the configured test/prod API origin and the matching `qr-test2.chinaums.com` or `qr.chinaums.com` QR origin.

Add nullable `provider_order_id TEXT` through an idempotent migration, then create a partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_order_id_unique
ON orders(provider_order_id)
WHERE provider_order_id IS NOT NULL;
```

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS QR|provider order"`

Expected: focused tests PASS.

### Task 3: Callback Verification and Idempotent Entitlement

**Files:**

- Modify: `services/licensing/src/payments/chinaumsAuth.ts`
- Create: `services/licensing/src/payments/chinaumsWebhook.ts`
- Test: `services/licensing/test/chinaumsWebhook.test.ts`

- [ ] **Step 1: Write failing notification tests**

Construct a form containing `billNo`, `billStatus=PAID`, `notifyId`, `seqId`, merchant fields, amount and JSON `billPayment`. Sign decoded values with:

```ts
const canonical = [...fields.entries()]
  .filter(([key]) => key !== "sign")
  .sort(([left], [right]) => left.localeCompare(right, "en", { sensitivity: "variant" }))
  .map(([key, value]) => `${key}=${value}`)
  .join("&");
const sign = createHash("sha256")
  .update(canonical + notifyKey, "utf8")
  .digest("hex")
  .toUpperCase();
```

Tests cover valid payment, duplicate notification, body/sign tampering, duplicate keys, MD5, wrong merchant, wrong amount, non-paid status, malformed nested JSON and conflicting replay.

- [ ] **Step 2: Run callback tests and observe missing processor failure**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS webhook"`

Expected: FAIL because `ChinaumsWebhookProcessor` is absent.

- [ ] **Step 3: Implement strict form processing**

Parse with `URLSearchParams`, reject duplicate names and bound the number/length of inputs. Verify the signature before reading business fields. Require `billStatus=PAID`, nested `status=TRADE_SUCCESS`, configured merchant fields, safe integer amount and a valid local-time timestamp. Resolve `billNo` through the store and call:

```ts
licensing.recordWebhookPayment(notifyId, receivedAt, {
  orderId: order.id,
  transactionId: `chinaums_${seqId}`,
  amountFen: totalAmount,
  paidAt,
});
```

- [ ] **Step 4: Run callback and complete licensing tests**

Run: `npm --prefix services/licensing test`

Expected: all licensing tests PASS.

### Task 4: Query Recovery, HTTP Route, and Runtime Wiring

**Files:**

- Modify: `services/licensing/src/payments/chinaumsQr.ts`
- Modify: `services/licensing/src/server.ts`
- Modify: `services/licensing/src/main.ts`
- Test: `services/licensing/test/chinaumsServer.test.ts`

- [ ] **Step 1: Write failing HTTP integration tests**

Assert that order creation persists `providerOrderId`, a valid form callback returns plain `SUCCESS`, an invalid callback returns `FAILED`, and two identical callbacks extend the entitlement once. Simulate a missed callback and assert polling invokes `/v1/netpay/bills/query`, then returns an entitlement for a verified PAID result. Assert repeated polls inside five seconds do not issue another query.

- [ ] **Step 2: Run integration tests and observe missing route/recovery failures**

Run: `npm --prefix services/licensing test -- --test-name-pattern "ChinaUMS server"`

Expected: FAIL because runtime wiring and the callback route do not exist.

- [ ] **Step 3: Wire provider-specific behavior without changing other providers**

After `createPayment`, bind `providerOrderId` before returning the QR. Add optional ChinaUMS dependencies to `createLicensingServer`; enable `/v1/webhooks/chinaums` only when configured. Before returning a pending ChinaUMS order, use an in-memory map keyed by local order ID to enforce the five-second query interval. On verified PAID query results, call the same webhook payment path with a deterministic recovery event ID.

In `main.ts`, select test origin outside production and production origin only in production. Construct one provider and one callback processor from the same validated config.

- [ ] **Step 4: Run service tests and build**

Run:

```powershell
npm --prefix services/licensing test
npm --prefix services/licensing run build
```

Expected: both commands exit 0.

### Task 5: Documentation, Security Review, and Complete Verification

**Files:**

- Modify: `.env.example`
- Modify: `services/licensing/README.md`
- Modify: `docs/superpowers/specs/2026-08-10-chinaums-qr-payments-design.md` only if implementation evidence requires a correction.

- [ ] **Step 1: Document secret-free deployment placeholders**

Document every environment variable by name, keep values as placeholders, describe test/prod host selection and state that real activation still requires merchant onboarding and interface authorization.

- [ ] **Step 2: Run complete fresh verification**

Run:

```powershell
npm run license:test
npm run license:build
npm run test
npm run lint:check
npm run build
git diff --check
```

Expected: every command exits 0 with zero test failures.

- [ ] **Step 3: Perform security and secret review**

Review the full diff and scan changed files for private keys, real merchant IDs, API keys, tokens, QR payloads and `.env` contents. Confirm outbound hosts are fixed, callbacks fail closed, amounts are server-owned and replay handling is idempotent.

- [ ] **Step 4: Obtain one focused final review and re-verify**

Provide the design, changed payment files, test evidence and security invariants to one strongest available Claude review session. Apply blocking in-scope findings, rerun affected tests, then rerun the complete verification commands.

- [ ] **Step 5: Commit the verified implementation**

Stage only the ChinaUMS implementation, tests and documentation, then commit with:

```text
feat(payments): add ChinaUMS QR payments
```

## Exit Criteria

- No real merchant credential is present in Git or generated artifacts.
- QR creation, notification processing and recovery query follow the documented ChinaUMS bill APIs.
- Forged, mismatched, duplicate or ambiguous provider data cannot grant or extend an entitlement.
- A valid provider event grants the existing entitlement exactly once.
- Existing providers and the Zotero plugin continue to pass the full verification suite.
- Real production activation is reported as pending until assigned merchant credentials complete a small-value live transaction.
