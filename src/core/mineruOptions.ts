export type MinerUModelPreference = "auto" | "pipeline" | "vlm";
export type MinerUOcrMode = "always" | "never";
export type ResolvedMinerUModel = Exclude<MinerUModelPreference, "auto">;

export interface MinerUOptionPreferences {
  modelVersion: MinerUModelPreference;
  ocrMode: MinerUOcrMode;
}

export interface MinerUDocumentSignals {
  extractedText?: string;
  totalPages?: number;
}

export interface ResolvedMinerUOptions {
  modelVersion: ResolvedMinerUModel;
  enableOcr: boolean;
  textLayerUsable: boolean;
}

export function resolveMinerUOptions(
  preferences: MinerUOptionPreferences,
  signals: MinerUDocumentSignals,
): ResolvedMinerUOptions {
  const textLayerUsable = hasUsableTextLayer(signals);
  return {
    modelVersion:
      preferences.modelVersion === "auto"
        ? textLayerUsable
          ? "pipeline"
          : "vlm"
        : preferences.modelVersion,
    enableOcr: preferences.ocrMode === "always",
    textLayerUsable,
  };
}

export function hasUsableTextLayer(signals: MinerUDocumentSignals): boolean {
  const meaningfulLength = Array.from(signals.extractedText || "").filter(
    (character) => {
      const codePoint = character.codePointAt(0) || 0;
      return (
        !/\s/u.test(character) &&
        codePoint >= 32 &&
        codePoint !== 127 &&
        character !== "�"
      );
    },
  ).length;
  const pages = Math.max(1, Math.min(50, signals.totalPages || 1));
  return meaningfulLength >= Math.max(120, pages * 40);
}
