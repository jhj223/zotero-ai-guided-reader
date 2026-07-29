import { clearPref, getPref, setPref } from "../utils/prefs";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type LicensePreferenceKey =
  | "licenseDeviceId"
  | "licenseEntitlementToken";

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
