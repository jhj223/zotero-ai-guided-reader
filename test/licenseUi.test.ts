import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatPrice } from "../src/ui/LicensePanel";

test("formats server-owned integer prices without floating ambiguity", () => {
  assert.equal(formatPrice(1990), "¥19.90");
  assert.equal(formatPrice(19900), "¥199.00");
});

test("sidebar exposes trial, monthly, yearly, QR, and automatic polling UI", async () => {
  const [app, panel, hook] = await Promise.all([
    readFile(new URL("../src/ui/GuidedReaderApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/LicensePanel.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/ui/useLicenseController.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(app, /<LicensePanel controller=\{license\}/);
  assert.match(app, /canUseCommercialActions/);
  assert.match(panel, /完整试用/);
  assert.match(panel, /Pro 年付/);
  assert.match(panel, /Pro 月付/);
  assert.match(panel, /order\.qrDataUrl/);
  assert.match(panel, /不会自动续扣/);
  assert.match(hook, /POLL_INTERVAL_MS = 3_000/);
  assert.match(hook, /MAX_POLLING_MS = 5 \* 60 \* 1000/);
  assert.match(hook, /manager\.pollOrder/);
  assert.match(app, /\.zg-plan-grid \{[^}]*minmax\(118px, 1fr\)/);
  assert.match(app, /\.zg-payment \{[^}]*minmax\(0, 1fr\)/);
});
