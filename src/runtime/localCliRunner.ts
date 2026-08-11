import {
  buildCliArguments,
  cliExecutableCandidates,
  cliExecutableNames,
  type CliPlatform,
  parseCliOutput,
  validateCliModel,
  type LocalCliProviderId,
} from "../core/localCli";

const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;

export interface SubprocessPipe {
  readString(): Promise<string>;
  write(value: string): Promise<unknown>;
  close(): Promise<unknown>;
}

interface SubprocessProcess {
  stdin: SubprocessPipe;
  stdout: SubprocessPipe;
  stderr: SubprocessPipe;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<unknown> | unknown;
}

interface SubprocessApi {
  call(options: {
    command: string;
    arguments: string[];
    workdir?: string;
    environment?: Record<string, string>;
    environmentAppend?: boolean;
    stderr?: "pipe" | "stdout";
  }): Promise<SubprocessProcess>;
  pathSearch?(name: string): Promise<string | null> | string | null;
}

export async function runLocalCli(input: {
  provider: LocalCliProviderId;
  model?: string;
  system: string;
  user: string;
}): Promise<string> {
  const model = validateCliModel(input.model);
  const subprocess = loadSubprocess();
  const command = await findCliExecutable(input.provider, subprocess);
  const workdir = PathUtils.join(
    Zotero.DataDirectory.dir,
    "zotero-ai-guided-reader",
    "cli-work",
  );
  await IOUtils.makeDirectory(workdir, { ignoreExisting: true });

  const process = await subprocess.call({
    command,
    arguments: buildCliArguments(input.provider, model),
    workdir,
    environment: { NO_COLOR: "1", TERM: "dumb" },
    environmentAppend: true,
    stderr: "pipe",
  });
  const stdoutPromise = readSubprocessOutput(process.stdout, process);
  const stderrPromise = readSubprocessOutput(process.stderr, process);
  const prompt = [
    input.system,
    "",
    "以下是用户请求。只完成文本生成，不读取文件、不调用工具：",
    input.user,
  ].join("\n");
  await process.stdin.write(prompt);
  await process.stdin.close();

  const [result, stdout, stderr] = await Promise.all([
    waitForProcess(process),
    stdoutPromise,
    stderrPromise,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `${providerLabel(input.provider)} 执行失败（退出码 ${result.exitCode}）：${sanitizeDiagnostic(stderr)}`,
    );
  }
  const output = parseCliOutput(input.provider, stdout);
  if (!output) throw new Error(`${providerLabel(input.provider)} 未返回内容。`);
  return output;
}

export async function readSubprocessOutput(
  pipe: Pick<SubprocessPipe, "readString">,
  process?: Pick<SubprocessProcess, "kill">,
  maxLength = MAX_OUTPUT_LENGTH,
): Promise<string> {
  let output = "";
  while (true) {
    const chunk = await pipe.readString();
    if (!chunk) return output;
    output += chunk;
    if (output.length > maxLength) {
      void process?.kill();
      throw new Error("本地 CLI 输出超过 2MB 安全上限。");
    }
  }
}

export async function validateLocalCli(
  provider: LocalCliProviderId,
): Promise<{ ok: boolean; message: string }> {
  try {
    const path = await findCliExecutable(provider, loadSubprocess());
    return { ok: true, message: `${providerLabel(provider)} 已就绪：${path}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadSubprocess(): SubprocessApi {
  const module = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  ) as unknown as { Subprocess?: SubprocessApi };
  if (!module.Subprocess)
    throw new Error("当前 Zotero 无法加载 Subprocess 模块。");
  return module.Subprocess;
}

async function findCliExecutable(
  provider: LocalCliProviderId,
  subprocess: SubprocessApi,
): Promise<string> {
  const platform = runtimePlatform();
  const candidates = cliExecutableCandidates(provider, platform, {
    APPDATA: Services.env.get("APPDATA"),
    HOME: Services.env.get("HOME"),
  });
  for (const candidate of candidates) {
    if (await IOUtils.exists(candidate)) return candidate;
  }
  for (const name of cliExecutableNames(provider, platform)) {
    const searched = await subprocess.pathSearch?.(name);
    if (searched && (await IOUtils.exists(searched))) return searched;
  }
  throw new Error(
    `${providerLabel(provider)} 未安装或未找到原生可执行文件。请先在终端完成安装和登录。`,
  );
}

function runtimePlatform(): CliPlatform {
  if (Services.appinfo.OS === "WINNT") return "windows";
  if (Services.appinfo.OS === "Darwin") return "macos";
  return "linux";
}

function waitForProcess(
  process: SubprocessProcess,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      void process.kill();
      reject(new Error("本地 CLI 生成超时（5 分钟）。"));
    }, PROCESS_TIMEOUT_MS);
    void process.wait().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function providerLabel(provider: LocalCliProviderId): string {
  return provider === "codex-cli" ? "Codex CLI" : "Claude Code CLI";
}

function sanitizeDiagnostic(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 500) || "无错误详情"
  );
}
