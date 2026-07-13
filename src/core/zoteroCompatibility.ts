export type ReaderPaneApi = "section" | "view" | "none";

export function chooseReaderPaneApi(manager: {
  registerSection?: unknown;
  registerView?: unknown;
}): ReaderPaneApi {
  if (typeof manager.registerSection === "function") return "section";
  if (typeof manager.registerView === "function") return "view";
  return "none";
}
