import { config } from "../../package.json";
import {
  getProviderHints,
  getProviderModels,
  LLM_PROVIDERS,
} from "../core/settings";
import type { LLMProviderId } from "../core/types";
import {
  getSemanticProviderModels,
  normalizeSemanticProvider,
  semanticProviderDefinition,
  type SemanticProviderId,
} from "../core/semanticSettings";
import { validateLlmKey, validateMinerUKey } from "../runtime/keyValidation";
import { fetchLlmModels, fetchSemanticModels } from "../runtime/modelDiscovery";
import {
  readProviderSettings,
  readSemanticSettings,
} from "../runtime/preferences";
import { SemanticClient } from "../runtime/semanticClient";
import { getPref, setPref } from "../utils/prefs";

export async function registerPrefsScripts(window: Window) {
  if (getPref("mineruOcrMode") === "auto") {
    setPref("mineruOcrMode", "never");
  }
  addon.data.prefs = { window };
  bindValidateButton(window, "llm");
  bindValidateButton(window, "mineru");
  bindValidateButton(window, "semantic");
  bindProviderControls(window);
  bindSemanticControls(window);
}

function bindSemanticControls(win: Window) {
  const providerSelect = element<HTMLSelectElement>(win, "semanticProvider");
  const modelSelect = element<HTMLSelectElement>(win, "semanticModel");
  const customModel = element<HTMLInputElement>(win, "semanticCustomModel");
  const fetchModelsButton = win.document.querySelector<HTMLButtonElement>(
    `#${config.addonRef}-fetch-semantic-models`,
  );
  const fetchedModels = readSemanticModelCache();

  const updateCustomVisibility = () => {
    const visible = modelSelect?.value === "__custom__";
    win.document
      .querySelectorAll<HTMLElement>(".zg-semantic-custom-model")
      .forEach((node: HTMLElement) => {
        node.hidden = !visible;
      });
  };

  const applyProvider = (
    resetModel: boolean,
    persistModel: boolean,
    fromPrefs = false,
  ) => {
    if (!providerSelect || !modelSelect) return;
    const provider = normalizeSemanticProvider(
      fromPrefs
        ? String(getPref("semanticProvider") || providerSelect.value)
        : providerSelect.value,
    );
    if (fromPrefs) providerSelect.value = provider;
    const definition = semanticProviderDefinition(provider);
    const enabled = definition.kind !== "disabled";
    const models =
      fetchedModels[provider] || getSemanticProviderModels(provider);
    const previous = resetModel
      ? ""
      : fromPrefs
        ? String(getPref("semanticModel") || "")
        : modelSelect.value;

    modelSelect.replaceChildren();
    appendOption(
      win,
      modelSelect,
      definition.defaultModel
        ? `提供商默认（${definition.defaultModel}）`
        : enabled
          ? "请选择或填写模型"
          : "语义定位已关闭",
      "",
    );
    models.forEach((model) => appendOption(win, modelSelect, model, model));
    if (enabled) {
      appendOption(win, modelSelect, "自定义模型名...", "__custom__");
    }

    if (previous && models.includes(previous)) {
      modelSelect.value = previous;
    } else if (previous && previous !== "__custom__" && enabled) {
      modelSelect.value = "__custom__";
      if (customModel) customModel.value = previous;
    } else {
      modelSelect.value = previous === "__custom__" && enabled ? previous : "";
    }

    win.document
      .querySelectorAll<HTMLElement>(".zg-semantic-enabled")
      .forEach((node: HTMLElement) => {
        node.hidden = !enabled;
      });
    win.document
      .querySelectorAll<HTMLElement>(".zg-semantic-key")
      .forEach((node: HTMLElement) => {
        node.hidden = !enabled || definition.kind === "ollama";
      });
    setPlaceholder(win, "semanticBaseUrl", definition.baseUrl);
    updateCustomVisibility();
    if (persistModel) {
      modelSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
  };

  providerSelect?.addEventListener("change", () => applyProvider(true, true));
  providerSelect?.addEventListener("syncfrompreference", () =>
    applyProvider(false, false, true),
  );
  modelSelect?.addEventListener("change", updateCustomVisibility);
  modelSelect?.addEventListener("syncfrompreference", updateCustomVisibility);
  fetchModelsButton?.addEventListener("click", () => {
    void (async () => {
      fetchModelsButton.disabled = true;
      try {
        if (!providerSelect || !modelSelect) return;
        const provider = normalizeSemanticProvider(providerSelect.value);
        const result = await (async () => {
          try {
            return await fetchSemanticModels(
              readSemanticSettingsFromControls(win, provider, modelSelect),
            );
          } catch (error) {
            showToast(
              `获取语义模型失败：${error instanceof Error ? error.message : String(error)}`,
              false,
            );
            return undefined;
          }
        })();
        if (!result) return;
        showToast(
          `已从 ${result.providerLabel} 获取 ${result.models.length} 个 Embedding 模型`,
          true,
        );
        try {
          fetchedModels[provider] = result.models;
          setPref("semanticFetchedModels", JSON.stringify(fetchedModels));
          applyProvider(false, false);
        } catch (error) {
          showToast(
            `模型已获取，但更新语义模型列表失败：${error instanceof Error ? error.message : String(error)}`,
            false,
          );
        }
      } finally {
        fetchModelsButton.disabled = false;
      }
    })();
  });
  applyProvider(false, false, true);
}

function bindProviderControls(win: Window) {
  const providerSelect = element<HTMLSelectElement>(win, "llmProvider");
  const modelSelect = element<HTMLSelectElement>(win, "llmModel");
  const customModel = element<HTMLInputElement>(win, "llmCustomModel");
  const fetchModelsButton = win.document.querySelector<HTMLButtonElement>(
    `#${config.addonRef}-fetch-models`,
  );
  const fetchedModels = readFetchedModelCache();

  const updateCustomVisibility = () => {
    const visible = modelSelect?.value === "__custom__";
    win.document
      .querySelectorAll<HTMLElement>(".zg-custom-model")
      .forEach((node: HTMLElement) => {
        node.hidden = !visible;
      });
  };

  const applyProvider = (
    resetModel: boolean,
    persistModel: boolean,
    fromPrefs = false,
  ) => {
    if (!providerSelect || !modelSelect) return;
    const provider = normalizeProvider(
      fromPrefs
        ? String(getPref("llmProvider") || providerSelect.value)
        : providerSelect.value,
    );
    if (fromPrefs) providerSelect.value = provider;
    const definition = LLM_PROVIDERS[provider];
    const models = fetchedModels[provider] || getProviderModels(provider);
    const previous = resetModel
      ? ""
      : fromPrefs
        ? String(getPref("llmModel") || "")
        : modelSelect.value;
    modelSelect.replaceChildren();
    appendOption(
      win,
      modelSelect,
      definition.defaultModel
        ? `提供商默认（${definition.defaultModel}）`
        : "使用 CLI 当前默认模型",
      "",
    );
    models.forEach((model) => {
      appendOption(win, modelSelect, model, model);
    });
    appendOption(win, modelSelect, "自定义模型名...", "__custom__");

    if (previous && models.includes(previous)) {
      modelSelect.value = previous;
    } else if (previous && previous !== "__custom__") {
      modelSelect.value = "__custom__";
      if (customModel) customModel.value = previous;
    } else {
      modelSelect.value = previous === "__custom__" ? previous : "";
    }

    const apiProvider = definition.kind === "api";
    win.document
      .querySelectorAll<HTMLElement>(".zg-api-only")
      .forEach((node: HTMLElement) => {
        node.hidden = !apiProvider;
      });
    win.document
      .querySelectorAll<HTMLElement>(".zg-cli-only")
      .forEach((node: HTMLElement) => {
        node.hidden = apiProvider;
      });
    const hints = getProviderHints(provider);
    setPlaceholder(
      win,
      "llmBaseUrl",
      hints.baseUrl ? `留空 = ${hints.baseUrl}` : "",
    );
    updateCustomVisibility();
    if (persistModel) {
      modelSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
  };

  providerSelect?.addEventListener("change", () => applyProvider(true, true));
  providerSelect?.addEventListener("syncfrompreference", () =>
    applyProvider(false, false, true),
  );
  modelSelect?.addEventListener("change", updateCustomVisibility);
  modelSelect?.addEventListener("syncfrompreference", updateCustomVisibility);
  fetchModelsButton?.addEventListener("click", () => {
    void (async () => {
      fetchModelsButton.disabled = true;
      try {
        if (!providerSelect || !modelSelect) return;
        const provider = normalizeProvider(providerSelect.value);
        const result = await (async () => {
          try {
            return await fetchLlmModels(
              readSettingsFromControls(win, provider, modelSelect),
            );
          } catch (error) {
            showToast(
              `获取模型失败：${error instanceof Error ? error.message : String(error)}`,
              false,
            );
            return undefined;
          }
        })();
        if (!result) return;
        showToast(
          `已从 ${result.providerLabel} 获取 ${result.models.length} 个模型`,
          true,
        );
        try {
          fetchedModels[provider] = result.models;
          setPref("llmFetchedModels", JSON.stringify(fetchedModels));
          applyProvider(false, false);
        } catch (error) {
          showToast(
            `模型已获取，但更新模型列表失败：${error instanceof Error ? error.message : String(error)}`,
            false,
          );
        }
      } finally {
        fetchModelsButton.disabled = false;
      }
    })();
  });
  applyProvider(false, false, true);
}

function readSettingsFromControls(
  win: Window,
  provider: LLMProviderId,
  modelSelect: HTMLSelectElement,
) {
  const stored = readProviderSettings();
  const customModel = element<HTMLInputElement>(win, "llmCustomModel");
  const apiKey = element<HTMLInputElement>(win, "llmApiKey");
  const baseUrl = element<HTMLInputElement>(win, "llmBaseUrl");
  const definition = LLM_PROVIDERS[provider];
  return {
    ...stored,
    llmProvider: provider,
    llmApiKey: apiKey?.value ?? stored.llmApiKey,
    model:
      modelSelect.value === "__custom__"
        ? customModel?.value || ""
        : modelSelect.value || definition.defaultModel,
    baseUrl: baseUrl?.value.trim() || definition.baseUrl || "",
  };
}

function readFetchedModelCache(): Partial<Record<LLMProviderId, string[]>> {
  const raw = String(getPref("llmFetchedModels") || "");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cache: Partial<Record<LLMProviderId, string[]>> = {};
    Object.keys(LLM_PROVIDERS).forEach((key) => {
      const provider = key as LLMProviderId;
      const models = parsed[provider];
      if (!Array.isArray(models)) return;
      const safeModels = [
        ...new Set(
          models.filter(
            (model): model is string =>
              typeof model === "string" &&
              model.length > 0 &&
              model.length <= 256,
          ),
        ),
      ].slice(0, 500);
      if (safeModels.length) cache[provider] = safeModels;
    });
    return cache;
  } catch {
    return {};
  }
}

function readSemanticModelCache(): Partial<
  Record<SemanticProviderId, string[]>
> {
  const raw = String(getPref("semanticFetchedModels") || "");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cache: Partial<Record<SemanticProviderId, string[]>> = {};
    Object.keys(parsed).forEach((key) => {
      const provider = normalizeSemanticProvider(key);
      if (provider === "none" && key !== "none") return;
      const models = parsed[key];
      if (!Array.isArray(models)) return;
      const safeModels = [
        ...new Set(
          models.filter(
            (model): model is string =>
              typeof model === "string" &&
              model.length > 0 &&
              model.length <= 256,
          ),
        ),
      ].slice(0, 500);
      if (safeModels.length) cache[provider] = safeModels;
    });
    return cache;
  } catch {
    return {};
  }
}

function readSemanticSettingsFromControls(
  win: Window,
  provider: SemanticProviderId,
  modelSelect: HTMLSelectElement,
) {
  const stored = readSemanticSettings();
  const definition = semanticProviderDefinition(provider);
  return {
    provider,
    apiKey:
      element<HTMLInputElement>(win, "semanticApiKey")?.value ?? stored.apiKey,
    model:
      modelSelect.value === "__custom__"
        ? element<HTMLInputElement>(win, "semanticCustomModel")?.value || ""
        : modelSelect.value || definition.defaultModel,
    baseUrl:
      element<HTMLInputElement>(win, "semanticBaseUrl")?.value.trim() ||
      definition.baseUrl,
  };
}

function bindValidateButton(win: Window, kind: "llm" | "mineru" | "semantic") {
  const button = win.document.querySelector<HTMLButtonElement>(
    `#${config.addonRef}-validate-${kind}`,
  );
  button?.addEventListener(
    "click",
    () => void runValidation(win, kind, button),
  );
}

async function runValidation(
  win: Window,
  kind: "llm" | "mineru" | "semantic",
  button: HTMLButtonElement,
) {
  button.disabled = true;
  try {
    const providerSettings = readProviderSettings();
    const result =
      kind === "mineru"
        ? await validateMinerUKey(providerSettings.mineruApiKey)
        : kind === "semantic"
          ? await validateSemanticControls(win)
          : await validateLlmKey(providerSettings);
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

async function validateSemanticControls(win: Window) {
  const provider = normalizeSemanticProvider(
    element<HTMLSelectElement>(win, "semanticProvider")?.value,
  );
  const definition = semanticProviderDefinition(provider);
  if (definition.kind === "disabled") {
    return { ok: true, message: "语义定位兜底已关闭" };
  }
  const modelSelect = element<HTMLSelectElement>(win, "semanticModel");
  if (!modelSelect) {
    return { ok: false, message: "语义定位模型控件未加载" };
  }
  const settings = readSemanticSettingsFromControls(win, provider, modelSelect);
  try {
    const scores = await new SemanticClient(settings).score("定位测试", [
      "定位测试文本",
    ]);
    return scores.length === 1 && Number.isFinite(scores[0])
      ? { ok: true, message: "语义定位连接校验通过" }
      : { ok: false, message: "语义定位服务未返回有效向量" };
  } catch (error) {
    return {
      ok: false,
      message: `语义定位连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function element<T extends HTMLElement>(win: Window, suffix: string): T | null {
  return win.document.querySelector<T>(
    `#zotero-prefpane-${config.addonRef}-${suffix}`,
  );
}

function setPlaceholder(win: Window, suffix: string, value: string) {
  const input = element<HTMLInputElement>(win, suffix);
  if (input) input.placeholder = value;
}

function appendOption(
  win: Window,
  select: HTMLSelectElement,
  label: string,
  value: string,
) {
  const option = win.document.createElement("option");
  option.textContent = label;
  option.value = value;
  select.append(option);
}

function normalizeProvider(value: string): LLMProviderId {
  return value in LLM_PROVIDERS ? (value as LLMProviderId) : "deepseek";
}

function showToast(text: string, ok: boolean) {
  try {
    new ztoolkit.ProgressWindow("AI 带读", { closeOtherProgressWindows: true })
      .createLine({ text, type: ok ? "success" : "fail" })
      .show(5000);
  } catch {
    ztoolkit.log("Failed to display AI guided reader status toast", {
      status: ok ? "success" : "failure",
    });
  }
}
