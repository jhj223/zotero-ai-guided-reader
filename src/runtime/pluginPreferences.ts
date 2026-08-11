import { config } from "../../package.json";

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;

export function openLicensePreferences(): void {
  Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
}
