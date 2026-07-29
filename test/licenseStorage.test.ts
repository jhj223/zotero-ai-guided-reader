import assert from "node:assert/strict";
import test from "node:test";
import {
  createLicenseStorage,
  type LicensePreferenceStore,
} from "../src/runtime/licenseStorage";

function setup(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const prefs: LicensePreferenceStore = {
    read: (key) => values.get(key) || "",
    write: (key, value) => {
      values.set(key, value);
    },
    clear: (key) => {
      values.delete(key);
    },
  };
  return { values, storage: createLicenseStorage(prefs) };
}

test("creates one random installation ID and reuses it", () => {
  const { values, storage } = setup();
  const first = storage.getOrCreateDeviceId(
    () => "12345678-1234-4234-8234-123456789abc",
  );
  const second = storage.getOrCreateDeviceId(
    () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );

  assert.equal(first, "12345678-1234-4234-8234-123456789abc");
  assert.equal(second, first);
  assert.equal(values.get("licenseDeviceId"), first);
});

test("stores only bounded compact entitlement tokens", () => {
  const { storage } = setup();
  const token = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
  storage.saveEntitlementToken(token);
  assert.equal(storage.readEntitlementToken(), token);
  assert.throws(() => storage.saveEntitlementToken("short"), /token/i);
  storage.clearEntitlementToken();
  assert.equal(storage.readEntitlementToken(), "");
});
