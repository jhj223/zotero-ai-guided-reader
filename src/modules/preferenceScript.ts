import { config } from "../../package.json";
import { getProviderHints } from "../core/settings";
import { readProviderSettings } from "../runtime/preferences";
import { validateLlmKey, validateMinerUKey } from "../runtime/keyValidation";

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = { window: _window };
  bindPrefEvents(_window);
}

function bindPrefEvents(win: Window) {
  bindValidateButton(win, "llm");
  bindValidateButton(win, "mineru");
  bindProviderHints(win);
}

function bindProviderHints(win: Window) {
  const select = win.document.querySelector<HTMLSelectElement>(
    `#zotero-prefpane-${config.addonRef}-llmProvider`,
  );
  const apply = () => {
    const hints = getProviderHints(select?.value);
    setPlaceholder(win, "llmModel", hints.model ? `留空 = ${hints.model}` : "");
    setPlaceholder(
      win,
      "llmBaseUrl",
      hints.baseUrl ? `留空 = ${hints.baseUrl}` : "",
    );
  };
  select?.addEventListener("change", apply);
  apply();
}

function setPlaceholder(win: Window, idSuffix: string, text: string) {
  const input = win.document.querySelector<HTMLInputElement>(
    `#zotero-prefpane-${config.addonRef}-${idSuffix}`,
  );
  if (input) input.placeholder = text;
}

function bindValidateButton(win: Window, kind: "llm" | "mineru") {
  const button = win.document.querySelector<HTMLButtonElement>(
    `#${config.addonRef}-validate-${kind}`,
  );
  button?.addEventListener("click", () => {
    void runValidation(kind, button);
  });
}

async function runValidation(
  kind: "llm" | "mineru",
  button: HTMLButtonElement,
) {
  button.disabled = true;
  try {
    const settings = readProviderSettings();
    const result =
      kind === "mineru"
        ? await validateMinerUKey(settings.mineruApiKey)
        : await validateLlmKey(settings);
    showToast(result.message, result.ok);
  } catch (error) {
    showToast(
      `校验过程出错：${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  } finally {
    button.disabled = false;
  }
}

function showToast(text: string, ok: boolean) {
  new ztoolkit.ProgressWindow("AI 带读", { closeOtherProgressWindows: true })
    .createLine({ text, type: ok ? "success" : "fail" })
    .show(5000);
}
