import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { config } from "../../package.json";
import { LicensePanel } from "./LicensePanel";
import { useLicenseController } from "./useLicenseController";

interface MountedLicensePreferences {
  root: Root;
  onUnload: () => void;
}

const roots = new Map<Window, MountedLicensePreferences>();

export function mountLicensePreferences(win: Window): void {
  const container = win.document.querySelector<HTMLElement>(
    `#${config.addonRef}-license-root`,
  );
  if (!container || roots.has(win)) return;

  const root = createRoot(container);
  const onUnload = () => unmountLicensePreferences(win);
  roots.set(win, { root, onUnload });
  win.addEventListener("unload", onUnload, { once: true });
  root.render(<LicensePreferencesApp />);
}

export function unmountLicensePreferences(win: Window): void {
  const mounted = roots.get(win);
  if (!mounted) return;
  win.removeEventListener("unload", mounted.onUnload);
  mounted.root.unmount();
  roots.delete(win);
}

export function unmountAllLicensePreferences(): void {
  [...roots.keys()].forEach(unmountLicensePreferences);
}

function LicensePreferencesApp() {
  const license = useLicenseController();
  return <LicensePanel controller={license} />;
}
