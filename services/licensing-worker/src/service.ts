import { constantTimeEqual, hashText, randomOpaqueId } from "./crypto";
import {
  LicensingStore,
  type CompletedPayment,
  type EntitlementRecord,
  type PaidPlanId,
  type StoredOrder,
  type VerifiedPaymentInput,
} from "./store";

const ORDER_TTL_MS = 72 * 60 * 60 * 1000;

export interface Plan {
  id: PaidPlanId;
  label: string;
  durationDays: 30 | 365;
  priceFen: 590 | 4900;
}

export const PLANS: readonly Plan[] = [
  {
    id: "pro_monthly",
    label: "Pro 月付",
    durationDays: 30,
    priceFen: 590,
  },
  {
    id: "pro_yearly",
    label: "Pro 年付",
    durationDays: 365,
    priceFen: 4900,
  },
];

export interface CreatedOrder {
  orderId: string;
  customOrderId: string;
  deviceId: string;
  planId: PaidPlanId;
  durationDays: 30 | 365;
  amountFen: number;
  status: "pending";
  pollToken: string;
  createdAt: number;
  expiresAt: number;
}

export class LicensingService {
  private readonly plans = new Map(PLANS.map((plan) => [plan.id, plan]));

  constructor(
    readonly store: LicensingStore,
    private readonly now: () => number = Date.now,
  ) {}

  catalog(): readonly Plan[] {
    return PLANS;
  }

  async startTrial(deviceId: string): Promise<EntitlementRecord> {
    assertDeviceId(deviceId);
    const startedAt = this.now();
    return this.store.startTrial(
      deviceId,
      startedAt,
      startedAt + 7 * 86_400_000,
    );
  }

  async createOrder(
    deviceId: string,
    planId: PaidPlanId,
  ): Promise<CreatedOrder> {
    assertDeviceId(deviceId);
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("UNKNOWN_PLAN");
    const createdAt = this.now();
    const pollToken = randomOpaqueId("poll");
    const stored = await this.store.createOrder({
      id: randomOpaqueId("ord"),
      customOrderId: randomOpaqueId("co"),
      deviceId,
      planId,
      durationDays: plan.durationDays,
      amountFen: plan.priceFen,
      pollTokenHash: await hashText(pollToken),
      createdAt,
      expiresAt: createdAt + ORDER_TTL_MS,
    });
    return {
      orderId: stored.id,
      customOrderId: stored.customOrderId,
      deviceId,
      planId,
      durationDays: stored.durationDays,
      amountFen: stored.amountFen,
      status: "pending",
      pollToken,
      createdAt,
      expiresAt: stored.expiresAt,
    };
  }

  async pollOrder(
    orderId: string,
    pollToken: string,
  ): Promise<StoredOrder | undefined> {
    assertOpaqueId(orderId, "ord");
    if (!/^poll_[A-Za-z0-9_-]{20,128}$/.test(pollToken)) return undefined;
    const order = await this.store.findOrder(orderId);
    if (!order) return undefined;
    const suppliedHash = await hashText(pollToken);
    return constantTimeEqual(order.pollTokenHash, suppliedHash)
      ? order
      : undefined;
  }

  async getEntitlement(
    deviceId: string,
  ): Promise<EntitlementRecord | undefined> {
    assertDeviceId(deviceId);
    return this.store.getEntitlement(deviceId);
  }

  completePayment(input: VerifiedPaymentInput): Promise<CompletedPayment> {
    return this.store.completePayment(input);
  }
}

function assertDeviceId(deviceId: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(deviceId)) {
    throw new Error("INVALID_DEVICE_ID");
  }
}

function assertOpaqueId(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{20,128}$`).test(value)) {
    throw new Error("INVALID_ORDER_ID");
  }
}
