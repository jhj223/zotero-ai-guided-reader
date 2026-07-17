export function hasReaderSectionApi(manager: {
  registerSection?: unknown;
}): boolean {
  return typeof manager.registerSection === "function";
}
