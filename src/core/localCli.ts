import type { LLMProviderId } from "./types";

export type LocalCliProviderId = Extract<
  LLMProviderId,
  "codex-cli" | "claude-cli"
>;

export function buildCliArguments(
  provider: LocalCliProviderId,
  model?: string,
): string[] {
  if (provider === "codex-cli") {
    return [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      ...(model ? ["--model", model] : []),
      "-",
    ];
  }

  return [
    "-p",
    "--safe-mode",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-chrome",
    "--effort",
    "max",
    ...(model ? ["--model", model] : []),
  ];
}

export function validateCliModel(
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) {
    throw new Error("本地 CLI 模型名包含不支持的字符。");
  }
  return model;
}

export function parseCliOutput(
  provider: LocalCliProviderId,
  output: string,
): string {
  const trimmed = output.trim();
  if (provider === "codex-cli") return trimmed;
  const payload = JSON.parse(trimmed) as { result?: unknown };
  if (typeof payload.result !== "string" || !payload.result.trim()) {
    throw new Error("Claude Code CLI 未返回 result 文本。");
  }
  return payload.result.trim();
}
