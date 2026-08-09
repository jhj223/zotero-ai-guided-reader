import { createHash } from "node:crypto";
import {
  LicensingStore,
  type EntitlementRecord,
  type StaticQrReceiptInput,
  type StaticQrReceiptResult,
  type StoredOrder,
} from "./database.js";
import type { PaymentProviderKind } from "./payments/provider.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORDER_TTL_MS = 15 * 60 * 1000;
const STATIC_QR_RESERVATION_MS = 48 * 60 * 60 * 1000;

export type PaidPlanId = "pro_monthly" | "pro_yearly";

export interface Plan {
  id: PaidPlanId;
  label: string;
  durationDays: 30 | 365;
  priceFen: number;
}

export const DEFAULT_PLANS: readonly Plan[] = [
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
];

export interface CreatedOrder {
  id: string;
  deviceId: string;
  planId: PaidPlanId;
  provider: StoredOrder["provider"];
  baseAmountFen: number;
  amountFen: number;
  amountReservedUntil: number;
  durationDays: number;
  status: StoredOrder["status"];
  pollToken: string;
  createdAt: number;
  expiresAt: number;
}

export class PaymentMismatchError extends Error {
  constructor() {
    super("The payment amount does not match the order.");
    this.name = "PaymentMismatchError";
  }
}

export class LicensingService {
  private readonly plansById: Map<PaidPlanId, Plan>;

  constructor(
    private readonly dependencies: {
      store: LicensingStore;
      plans: readonly Plan[];
      now: () => number;
      randomId: (prefix: string) => string;
    },
  ) {
    this.plansById = new Map(dependencies.plans.map((plan) => [plan.id, plan]));
  }

  catalog(): readonly Plan[] {
    return [...this.plansById.values()];
  }

  startTrial(deviceId: string): EntitlementRecord {
    assertDeviceId(deviceId);
    const startedAt = this.dependencies.now();
    return this.dependencies.store.startTrial(
      deviceId,
      startedAt,
      startedAt + 7 * DAY_MS,
    );
  }

  createOrder(
    deviceId: string,
    planId: PaidPlanId,
    provider: PaymentProviderKind = "sandbox",
  ): CreatedOrder {
    assertDeviceId(deviceId);
    const plan = this.plansById.get(planId);
    if (!plan) throw new Error("UNKNOWN_PLAN");
    const createdAt = this.dependencies.now();
    const pollToken = this.dependencies.randomId("poll");
    const order: StoredOrder = {
      id: this.dependencies.randomId("order"),
      deviceId,
      planId,
      durationDays: plan.durationDays,
      provider,
      baseAmountFen: plan.priceFen,
      amountFen: plan.priceFen,
      amountReservedUntil:
        provider === "wechat-static-qr"
          ? createdAt + STATIC_QR_RESERVATION_MS
          : createdAt + ORDER_TTL_MS,
      status: "pending",
      pollTokenHash: hashToken(pollToken),
      createdAt,
      expiresAt: createdAt + ORDER_TTL_MS,
    };
    const storedOrder = this.dependencies.store.insertOrder(order);
    return { ...storedOrder, pollToken };
  }

  getOrder(orderId: string, pollToken: string): StoredOrder | undefined {
    const order = this.dependencies.store.findOrder(orderId);
    if (!order || !safeHashEqual(order.pollTokenHash, hashToken(pollToken))) {
      return undefined;
    }
    return order;
  }

  bindProviderOrderId(orderId: string, providerOrderId: string): string {
    if (!/^[A-Za-z0-9]{7,31}$/.test(providerOrderId)) {
      throw new Error("INVALID_PROVIDER_ORDER_ID");
    }
    try {
      return this.dependencies.store.bindProviderOrderId(
        orderId,
        providerOrderId,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PROVIDER_ORDER_ALREADY_BOUND"
      ) {
        throw new Error("Provider order is already bound.", { cause: error });
      }
      throw error;
    }
  }

  findOrderByProviderOrderId(providerOrderId: string): StoredOrder | undefined {
    if (!/^[A-Za-z0-9]{7,31}$/.test(providerOrderId)) return undefined;
    return this.dependencies.store.findOrderByProviderOrderId(providerOrderId);
  }

  getEntitlement(deviceId: string): EntitlementRecord | undefined {
    assertDeviceId(deviceId);
    return this.dependencies.store.getEntitlement(deviceId);
  }

  completeSandboxPayment(
    orderId: string,
    transactionId: string,
    paidAt: number,
  ): EntitlementRecord {
    const order = this.dependencies.store.findOrder(orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    return this.recordPayment({
      orderId,
      transactionId,
      amountFen: order.amountFen,
      paidAt,
    });
  }

  recordPayment(input: {
    orderId: string;
    transactionId: string;
    amountFen: number;
    paidAt: number;
  }): EntitlementRecord {
    try {
      const result = this.dependencies.store.markPaid(input);
      if (!result) throw new Error("ORDER_NOT_FOUND");
      return result.entitlement;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PAYMENT_AMOUNT_MISMATCH"
      ) {
        throw new PaymentMismatchError();
      }
      throw error;
    }
  }

  recordWebhookPayment(
    eventId: string,
    receivedAt: number,
    input: {
      orderId: string;
      transactionId: string;
      amountFen: number;
      paidAt: number;
    },
  ): { isReplay: boolean; entitlement: EntitlementRecord } {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
      throw new Error("INVALID_WEBHOOK_EVENT_ID");
    }
    return this.dependencies.store.recordWebhookPayment(
      eventId,
      receivedAt,
      input,
    );
  }

  recordStaticQrReceipt(
    input: StaticQrReceiptInput,
    receivedAt: number,
    nonceHash: string,
  ): StaticQrReceiptResult {
    return this.dependencies.store.recordStaticQrReceipt(
      input,
      receivedAt,
      nonceHash,
      {
        nonceRetentionMs: 10 * 60 * 1000,
        orderTimeSkewMs: 2 * 60 * 1000,
      },
    );
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function assertDeviceId(deviceId: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
    throw new Error("INVALID_DEVICE_ID");
  }
}
