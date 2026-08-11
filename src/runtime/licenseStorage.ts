import { clearPref, getPref, setPref } from "../utils/prefs";
import { type LicenseOrder, validateAfdianCheckoutUrl } from "./licenseClient";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type LicensePreferenceKey =
  | "licenseDeviceId"
  | "licenseEntitlementToken"
  | "licensePendingOrder";

export interface LicensePreferenceStore {
  read(key: LicensePreferenceKey): string;
  write(key: LicensePreferenceKey, value: string): void;
  clear(key: LicensePreferenceKey): void;
}

export interface LicenseStorage {
  getOrCreateDeviceId(randomUuid?: () => string): string;
  readEntitlementToken(): string;
  saveEntitlementToken(token: string): void;
  clearEntitlementToken(): void;
  readPendingOrder(): LicenseOrder | undefined;
  savePendingOrder(order: LicenseOrder): void;
  clearPendingOrder(): void;
}

export function createLicenseStorage(
  preferences: LicensePreferenceStore,
): LicenseStorage {
  return {
    getOrCreateDeviceId(
      randomUuid: () => string = () => crypto.randomUUID(),
    ): string {
      const existing = preferences.read("licenseDeviceId");
      if (DEVICE_ID_PATTERN.test(existing)) return existing;
      const created = randomUuid();
      if (!DEVICE_ID_PATTERN.test(created)) {
        throw new Error("Generated license device identifier is invalid.");
      }
      preferences.write("licenseDeviceId", created);
      return created;
    },

    readEntitlementToken(): string {
      const token = preferences.read("licenseEntitlementToken");
      return validToken(token) ? token : "";
    },

    saveEntitlementToken(token: string): void {
      if (!validToken(token)) {
        throw new Error("Entitlement token is invalid.");
      }
      preferences.write("licenseEntitlementToken", token);
    },

    clearEntitlementToken(): void {
      preferences.clear("licenseEntitlementToken");
    },

    readPendingOrder(): LicenseOrder | undefined {
      const serialized = preferences.read("licensePendingOrder");
      if (!serialized || serialized.length > 4_096) return undefined;
      try {
        return validatePendingOrder(JSON.parse(serialized) as unknown);
      } catch {
        preferences.clear("licensePendingOrder");
        return undefined;
      }
    },

    savePendingOrder(order: LicenseOrder): void {
      const validated = validatePendingOrder(order);
      const serialized = JSON.stringify(validated);
      if (serialized.length > 4_096) {
        throw new Error("Pending license order is too large.");
      }
      preferences.write("licensePendingOrder", serialized);
    },

    clearPendingOrder(): void {
      preferences.clear("licensePendingOrder");
    },
  };
}

export const licenseStorage = createLicenseStorage({
  read: (key) => String(getPref(key) || ""),
  write: (key, value) => {
    setPref(key, value);
  },
  clear: (key) => {
    clearPref(key);
  },
});

function validToken(token: string): boolean {
  return (
    token.length >= 32 && token.length <= 8_192 && TOKEN_PATTERN.test(token)
  );
}

function validatePendingOrder(value: unknown): LicenseOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pending license order is invalid.");
  }
  const order = value as Record<string, unknown>;
  if (
    typeof order.orderId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(order.orderId) ||
    typeof order.pollToken !== "string" ||
    !/^[A-Za-z0-9_-]{8,256}$/.test(order.pollToken) ||
    order.status !== "pending" ||
    (order.planId !== "pro_monthly" && order.planId !== "pro_yearly") ||
    !Number.isSafeInteger(order.amountFen) ||
    Number(order.amountFen) <= 0 ||
    typeof order.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(order.expiresAt))
  ) {
    throw new Error("Pending license order is invalid.");
  }
  const checkoutUrl =
    typeof order.checkoutUrl === "string"
      ? validateAfdianCheckoutUrl(order.checkoutUrl)
      : undefined;
  const qrDataUrl =
    typeof order.qrDataUrl === "string" &&
    /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(order.qrDataUrl)
      ? order.qrDataUrl
      : undefined;
  if (!checkoutUrl && !qrDataUrl) {
    throw new Error("Pending license order has no checkout mechanism.");
  }
  return {
    orderId: order.orderId,
    pollToken: order.pollToken,
    status: "pending",
    planId: order.planId,
    amountFen: Number(order.amountFen),
    expiresAt: new Date(order.expiresAt).toISOString(),
    ...(checkoutUrl ? { checkoutUrl } : {}),
    ...(qrDataUrl ? { qrDataUrl } : {}),
  };
}
