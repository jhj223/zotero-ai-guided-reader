import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCliArguments,
  cliExecutableCandidates,
  cliExecutableNames,
  parseCliOutput,
  validateCliModel,
} from "../src/core/localCli";
import { readSubprocessOutput } from "../src/runtime/localCliRunner";

test("Codex CLI invocation is ephemeral, read-only, and reads the prompt from stdin", () => {
  const args = buildCliArguments("codex-cli", "gpt-5.4");
  assert.deepEqual(args.slice(0, 2), ["exec", "--ephemeral"]);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.deepEqual(
    args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
    ["--sandbox", "read-only"],
  );
  assert.equal(args.at(-1), "-");
  assert.ok(!args.some((arg) => arg.includes("paper text")));
});

test("Claude CLI invocation disables tools, MCP, and session persistence", () => {
  const args = buildCliArguments("claude-cli", "opus");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(
    args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2),
    ["--tools", ""],
  );
  assert.deepEqual(
    args.slice(
      args.indexOf("--output-format"),
      args.indexOf("--output-format") + 2,
    ),
    ["--output-format", "json"],
  );
});

test("discovers native CLI names and known paths on every supported desktop OS", () => {
  assert.deepEqual(cliExecutableNames("codex-cli", "windows"), ["codex.exe"]);
  assert.deepEqual(cliExecutableNames("claude-cli", "macos"), ["claude"]);
  assert.deepEqual(cliExecutableNames("claude-cli", "linux"), ["claude"]);

  assert.ok(
    cliExecutableCandidates("codex-cli", "windows", {
      APPDATA: "C:\\Users\\reader\\AppData\\Roaming",
    }).some((path) => path.endsWith("codex.exe")),
  );
  assert.ok(
    cliExecutableCandidates("claude-cli", "macos", {
      HOME: "/Users/reader",
    }).includes("/opt/homebrew/bin/claude"),
  );
  assert.ok(
    cliExecutableCandidates("codex-cli", "linux", {
      HOME: "/home/reader",
    }).includes("/home/reader/.local/bin/codex"),
  );
});

test("parses Claude JSON output and keeps Codex final text", () => {
  assert.equal(
    parseCliOutput("claude-cli", '{"result":"{\\"ok\\":true}"}'),
    '{"ok":true}',
  );
  assert.equal(
    parseCliOutput("codex-cli", "  final answer  \n"),
    "final answer",
  );
});

test("rejects unsafe CLI model arguments without invoking a shell", () => {
  assert.equal(validateCliModel("gpt-5.4"), "gpt-5.4");
  assert.throws(() => validateCliModel("opus & calc.exe"));
});

test("reads every subprocess output chunk until EOF", async () => {
  const chunks = ["first ", "second", ""];
  const output = await readSubprocessOutput({
    async readString() {
      return chunks.shift() ?? "";
    },
  });

  assert.equal(output, "first second");
});

test("kills a subprocess whose streamed output exceeds the safety limit", async () => {
  const chunks = ["1234", "5678", ""];
  let killed = false;

  await assert.rejects(
    readSubprocessOutput(
      {
        async readString() {
          return chunks.shift() ?? "";
        },
      },
      {
        kill() {
          killed = true;
        },
      },
      6,
    ),
    /2MB/,
  );
  assert.equal(killed, true);
});
