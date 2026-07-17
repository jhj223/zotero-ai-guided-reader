import { config } from "../../package.json";
import { maskSecret, validateProviderSettings } from "../core/settings";
import { readProviderSettings } from "../runtime/preferences";

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = { window: _window };
  bindPrefEvents(_window);
}

function bindPrefEvents(win: Window) {
  win.document
    .querySelector(`#${config.addonRef}-validate-llm`)
    ?.addEventListener("click", () => validate("llm", win));
  win.document
    .querySelector(`#${config.addonRef}-validate-mineru`)
    ?.addEventListener("click", () => validate("mineru", win));
}

function validate(kind: "llm" | "mineru", win: Window) {
  const settings = readProviderSettings();
  const errors = validateProviderSettings(settings).filter((error) =>
    kind === "llm" ? error.startsWith("LLM") : error.startsWith("MinerU"),
  );
  if (errors.length) {
    win.alert(errors.join("\n"));
    return;
  }
  const masked =
    kind === "llm"
      ? maskSecret(settings.llmApiKey)
      : maskSecret(settings.mineruApiKey);
  win.alert(`Local validation passed for ${kind.toUpperCase()} key ${masked}.`);
}
