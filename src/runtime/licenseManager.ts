import { version as clientVersion } from "../../package.json";
import {
  readBundledLicenseConfig,
  type LicenseRuntimeConfig,
} from "../core/licenseConfig";
import type {
  EntitlementState,
  EntitlementStatus,
  LicensePlanId,
} from "../core/license";
import {
  verifySignedEntitlement,
  verifySignedEntitlementState,
} from "../core/licenseToken";
import {
  LicenseApiError,
  LicenseClient,
  type IssuedEntitlement,
  type LicenseCatalog,
  type LicenseOrder,
  type LicensePlan,
  type PaidPlanId,
  type PolledLicenseOrder,
} from "./licenseClient";
import { licenseStorage, type LicenseStorage } from "./licenseStorage";

export interface LicenseGateway {
  catalog(signal?: AbortSignal): Promise<LicenseCatalog>;
  startTrial(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<IssuedEntitlement>;
  createOrder(
    deviceId: string,
    planId: PaidPlanId,
    signal?: AbortSignal,
  ): Promise<LicenseOrder>;
  pollOrder(
    orderId: string,
    pollToken: string,
    signal?: AbortSignal,
  ): Promise<PolledLicenseOrder>;
  refresh(
    deviceId: string,
    entitlementToken: string,
    signal?: AbortSignal,
  ): Promise<IssuedEntitlement>;
}

export type LicenseUiStatus =
  | EntitlementStatus
  | "loading"
  | "unavailable"
  | "error";

export interface LicenseSnapshot {
  status: LicenseUiStatus;
  canUsePro: boolean;
  plans: LicensePlan[];
  deviceId?: string;
  validUntil?: number;
  remainingDays?: number;
  planId?: LicensePlanId;
  message?: string;
}

export interface LicensePollResult {
  order: PolledLicenseOrder;
  snapshot?: LicenseSnapshot;
}

export class ProEntitlementRequiredError extends Error {
  constructor() {
    super("此操作需要有效的试用或 Pro 授权。");
    this.name = "ProEntitlementRequiredError";
  }
}

export class LicenseManager {
  private snapshot: LicenseSnapshot = {
    status: "loading",
    canUsePro: false,
    plans: [],
  };
  private initialization?: Promise<LicenseSnapshot>;

  constructor(
    private readonly dependencies: {
      config: LicenseRuntimeConfig;
      gateway?: LicenseGateway;
      storage: LicenseStorage;
      now?: () => number;
    },
  ) {}

  current(): LicenseSnapshot {
    return this.snapshot;
  }

  initialize(signal?: AbortSignal): Promise<LicenseSnapshot> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().finally(() => {
        this.initialization = undefined;
      });
    }
    return waitForInitialization(this.initialization, signal);
  }

  async requirePro(signal?: AbortSignal): Promise<LicenseSnapshot> {
    const snapshot = await this.initialize(signal);
    if (!snapshot.canUsePro) throw new ProEntitlementRequiredError();
    return snapshot;
  }

  async createOrder(
    planId: PaidPlanId,
    signal?: AbortSignal,
  ): Promise<LicenseOrder> {
    const { gateway } = this.requireEnabled();
    const deviceId = this.dependencies.storage.getOrCreateDeviceId();
    const order = await gateway.createOrder(deviceId, planId, signal);
    this.dependencies.storage.savePendingOrder(order);
    return order;
  }

  pendingOrder(): LicenseOrder | undefined {
    return this.dependencies.storage.readPendingOrder();
  }

  dismissPendingOrder(): void {
    this.dependencies.storage.clearPendingOrder();
  }

  async pollOrder(
    order: Pick<LicenseOrder, "orderId" | "pollToken">,
    signal?: AbortSignal,
  ): Promise<LicensePollResult> {
    const { gateway } = this.requireEnabled();
    const result = await gateway.pollOrder(
      order.orderId,
      order.pollToken,
      signal,
    );
    if (result.status !== "paid" || !result.entitlementToken) {
      if (result.status !== "pending") {
        this.dependencies.storage.clearPendingOrder();
      }
      return { order: result };
    }
    const snapshot = await this.acceptIssued(
      {
        entitlementToken: result.entitlementToken,
      },
      this.snapshot.plans,
    );
    this.dependencies.storage.clearPendingOrder();
    return { order: result, snapshot };
  }

  private async initializeOnce(signal?: AbortSignal): Promise<LicenseSnapshot> {
    if (!this.dependencies.config.enabled) {
      return this.setSnapshot({
        status: "unavailable",
        canUsePro: false,
        plans: [],
        message: this.dependencies.config.reason,
      });
    }
    const gateway = this.dependencies.gateway;
    if (!gateway) {
      return this.setSnapshot({
        status: "error",
        canUsePro: false,
        plans: [],
        message: "授权客户端未初始化。",
      });
    }
    const deviceId = this.dependencies.storage.getOrCreateDeviceId();
    let plans: LicensePlan[] = [];
    let catalogMessage: string | undefined;
    try {
      plans = (await gateway.catalog(signal)).plans;
    } catch (error) {
      catalogMessage = describeLicenseError(error);
    }

    const storedToken = this.dependencies.storage.readEntitlementToken();
    if (storedToken) {
      try {
        const verified = await verifySignedEntitlementState(
          storedToken,
          this.dependencies.config.publicKeys,
          this.verificationOptions(deviceId),
        );
        if (verified.state.canUsePro) {
          return this.setSnapshot(
            snapshotFromEntitlement(
              verified.state,
              verified.claims.planId,
              deviceId,
              plans,
              catalogMessage,
            ),
          );
        }
        try {
          const refreshed = await gateway.refresh(
            deviceId,
            storedToken,
            signal,
          );
          return await this.acceptIssued(refreshed, plans);
        } catch (refreshError) {
          return this.setSnapshot(
            snapshotFromEntitlement(
              verified.state,
              verified.claims.planId,
              deviceId,
              plans,
              describeLicenseError(refreshError),
            ),
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Unknown entitlement signing key."
        ) {
          return this.setSnapshot({
            status: "error",
            canUsePro: false,
            plans,
            deviceId,
            message: "授权使用了新版签名密钥，请更新插件后重试。",
          });
        }
        this.dependencies.storage.clearEntitlementToken();
      }
    }

    try {
      return await this.acceptIssued(
        await gateway.startTrial(deviceId, signal),
        plans,
      );
    } catch (error) {
      return this.setSnapshot({
        status: "error",
        canUsePro: false,
        plans,
        deviceId,
        message: describeLicenseError(error),
      });
    }
  }

  private async acceptIssued(
    issued: Pick<IssuedEntitlement, "entitlementToken">,
    plans: LicensePlan[],
  ): Promise<LicenseSnapshot> {
    if (!this.dependencies.config.enabled) {
      throw new Error("License authority is not configured.");
    }
    const deviceId = this.dependencies.storage.getOrCreateDeviceId();
    const claims = await verifySignedEntitlement(
      issued.entitlementToken,
      this.dependencies.config.publicKeys,
      this.verificationOptions(deviceId),
    );
    this.dependencies.storage.saveEntitlementToken(issued.entitlementToken);
    return this.setSnapshot({
      status: claims.kind,
      canUsePro: true,
      plans,
      deviceId,
      validUntil: claims.validUntil,
      planId: claims.planId,
      remainingDays: Math.max(
        1,
        Math.ceil((claims.validUntil - this.now()) / (24 * 60 * 60 * 1000)),
      ),
    });
  }

  private requireEnabled(): {
    config: Extract<LicenseRuntimeConfig, { enabled: true }>;
    gateway: LicenseGateway;
  } {
    if (!this.dependencies.config.enabled || !this.dependencies.gateway) {
      throw new Error("当前构建未配置官方授权服务。");
    }
    return {
      config: this.dependencies.config,
      gateway: this.dependencies.gateway,
    };
  }

  private verificationOptions(deviceId: string) {
    if (!this.dependencies.config.enabled) {
      throw new Error("License authority is not configured.");
    }
    return {
      deviceId,
      issuer: this.dependencies.config.issuer,
      audience: this.dependencies.config.audience,
      now: this.now(),
    };
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private setSnapshot(snapshot: LicenseSnapshot): LicenseSnapshot {
    this.snapshot = snapshot;
    return snapshot;
  }
}

function waitForInitialization(
  initialization: Promise<LicenseSnapshot>,
  signal?: AbortSignal,
): Promise<LicenseSnapshot> {
  if (!signal) return initialization;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void initialization.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortError(): Error {
  const error = new Error("License initialization aborted.");
  error.name = "AbortError";
  return error;
}

let bundledManager: LicenseManager | undefined;

export function getLicenseManager(): LicenseManager {
  if (bundledManager) return bundledManager;
  const config = readBundledLicenseConfig();
  bundledManager = new LicenseManager({
    config,
    gateway: config.enabled
      ? new LicenseClient({
          baseUrl: config.baseUrl,
          clientVersion,
          allowLoopbackHttp: config.allowLoopbackHttp,
        })
      : undefined,
    storage: licenseStorage,
  });
  return bundledManager;
}

function snapshotFromEntitlement(
  state: EntitlementState,
  planId: LicensePlanId,
  deviceId: string,
  plans: LicensePlan[],
  message?: string,
): LicenseSnapshot {
  return {
    status: state.status,
    canUsePro: state.canUsePro,
    plans,
    deviceId,
    validUntil: state.validUntil,
    remainingDays: state.remainingDays,
    planId,
    message,
  };
}

function describeLicenseError(error: unknown): string {
  if (error instanceof LicenseApiError || error instanceof Error) {
    return error.message;
  }
  return "授权服务暂时不可用。";
}
