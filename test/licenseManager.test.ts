import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { EntitlementSigner } from "../services/licensing/src/entitlements";
import type { LicenseRuntimeConfig } from "../src/core/licenseConfig";
import type {
  IssuedEntitlement,
  LicenseCatalog,
  LicenseOrder,
  PolledLicenseOrder,
} from "../src/runtime/licenseClient";
import {
  LicenseManager,
  type LicenseGateway,
} from "../src/runtime/licenseManager";
import type { LicenseStorage } from "../src/runtime/licenseStorage";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 6, 29, 12);

function setup() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let sequence = 0;
  const signer = new EntitlementSigner(pair.privateKey, pair.publicKey, {
    keyId: "license-key-2026-07",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    randomTokenId: () => `entitlement_${++sequence}`,
  });
  const config: LicenseRuntimeConfig = {
    enabled: true,
    baseUrl: "https://license.example.test",
    issuer: "https://license.example.test",
    audience: "zotero-ai-guided-reader",
    publicKeys: {
      "license-key-2026-07": pair.publicKey.export({ format: "jwk" }),
    },
    allowLoopbackHttp: false,
  };
  let storedToken = "";
  const storage: LicenseStorage = {
    getOrCreateDeviceId: () => "device-123",
    readEntitlementToken: () => storedToken,
    saveEntitlementToken: (token) => {
      storedToken = token;
    },
    clearEntitlementToken: () => {
      storedToken = "";
    },
  };
  const catalog: LicenseCatalog = {
    trialDays: 7,
    plans: [
      {
        id: "pro_monthly",
        label: "Pro 月付",
        durationDays: 30,
        priceFen: 1990,
      },
      {
        id: "pro_yearly",
        label: "Pro 年付",
        durationDays: 365,
        priceFen: 19900,
      },
    ],
  };
  return {
    signer,
    config,
    storage,
    catalog,
    readStoredToken: () => storedToken,
    setStoredToken: (value: string) => {
      storedToken = value;
    },
  };
}

function issued(
  signer: EntitlementSigner,
  input: {
    kind: "trial" | "pro";
    planId: "trial" | "pro_monthly" | "pro_yearly";
    issuedAt?: number;
    validUntil: number;
  },
): IssuedEntitlement {
  return {
    status: input.kind,
    validUntil: new Date(input.validUntil).toISOString(),
    entitlementToken: signer.sign(
      {
        deviceId: "device-123",
        kind: input.kind,
        planId: input.planId,
        validUntil: input.validUntil,
        updatedAt: input.issuedAt ?? now,
      },
      input.issuedAt ?? now,
    ),
  };
}

test("starts a seven-day trial and persists only a verified token", async () => {
  const state = setup();
  const trial = issued(state.signer, {
    kind: "trial",
    planId: "trial",
    validUntil: now + 7 * DAY_MS,
  });
  const gateway: LicenseGateway = {
    catalog: async () => state.catalog,
    startTrial: async () => trial,
    createOrder: async () => {
      throw new Error("not used");
    },
    pollOrder: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      throw new Error("not used");
    },
  };
  const manager = new LicenseManager({
    config: state.config,
    gateway,
    storage: state.storage,
    now: () => now,
  });

  const snapshot = await manager.initialize();
  assert.equal(snapshot.status, "trial");
  assert.equal(snapshot.canUsePro, true);
  assert.equal(snapshot.plans.length, 2);
  assert.equal(state.readStoredToken(), trial.entitlementToken);
});

test("keeps a verified local Pro entitlement usable when catalog is offline", async () => {
  const state = setup();
  const pro = issued(state.signer, {
    kind: "pro",
    planId: "pro_yearly",
    validUntil: now + 365 * DAY_MS,
  });
  state.setStoredToken(pro.entitlementToken);
  const gateway = {
    catalog: async () => {
      throw new Error("offline");
    },
    startTrial: async () => {
      throw new Error("not used");
    },
    createOrder: async () => {
      throw new Error("not used");
    },
    pollOrder: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      throw new Error("not used");
    },
  } satisfies LicenseGateway;
  const manager = new LicenseManager({
    config: state.config,
    gateway,
    storage: state.storage,
    now: () => now,
  });

  const snapshot = await manager.initialize();
  assert.equal(snapshot.status, "pro");
  assert.equal(snapshot.canUsePro, true);
  assert.deepEqual(snapshot.plans, []);
});

test("refreshes a signed token after its offline window expires", async () => {
  const state = setup();
  const stale = issued(state.signer, {
    kind: "pro",
    planId: "pro_yearly",
    issuedAt: now - 31 * DAY_MS,
    validUntil: now + 300 * DAY_MS,
  });
  const refreshed = issued(state.signer, {
    kind: "pro",
    planId: "pro_yearly",
    validUntil: now + 300 * DAY_MS,
  });
  state.setStoredToken(stale.entitlementToken);
  let refreshCount = 0;
  const gateway = {
    catalog: async () => state.catalog,
    startTrial: async () => {
      throw new Error("not used");
    },
    createOrder: async () => {
      throw new Error("not used");
    },
    pollOrder: async () => {
      throw new Error("not used");
    },
    refresh: async () => {
      refreshCount += 1;
      return refreshed;
    },
  } satisfies LicenseGateway;
  const manager = new LicenseManager({
    config: state.config,
    gateway,
    storage: state.storage,
    now: () => now,
  });

  const snapshot = await manager.initialize();
  assert.equal(snapshot.status, "pro");
  assert.equal(refreshCount, 1);
  assert.equal(state.readStoredToken(), refreshed.entitlementToken);
});

test("activates a paid order only after verifying its signed entitlement", async () => {
  const state = setup();
  const trial = issued(state.signer, {
    kind: "trial",
    planId: "trial",
    validUntil: now + 7 * DAY_MS,
  });
  const pro = issued(state.signer, {
    kind: "pro",
    planId: "pro_monthly",
    validUntil: now + 30 * DAY_MS,
  });
  const order: LicenseOrder = {
    orderId: "order_123456",
    pollToken: "poll_12345678",
    status: "pending",
    planId: "pro_monthly",
    amountFen: 1990,
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    qrDataUrl: "data:image/png;base64,aGVsbG8=",
  };
  const gateway: LicenseGateway = {
    catalog: async () => state.catalog,
    startTrial: async () => trial,
    createOrder: async () => order,
    pollOrder: async (): Promise<PolledLicenseOrder> => ({
      orderId: order.orderId,
      status: "paid",
      expiresAt: order.expiresAt,
      entitlementToken: pro.entitlementToken,
    }),
    refresh: async () => {
      throw new Error("not used");
    },
  };
  const manager = new LicenseManager({
    config: state.config,
    gateway,
    storage: state.storage,
    now: () => now,
  });
  await manager.initialize();

  assert.deepEqual(await manager.createOrder("pro_monthly"), order);
  const result = await manager.pollOrder(order);
  assert.equal(result.snapshot?.status, "pro");
  assert.equal(state.readStoredToken(), pro.entitlementToken);
});
