export type FetchLike<T = Response> = (
  url: string,
  init?: RequestInit,
) => Promise<T>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function normalizeServiceBaseUrl(
  value: string,
  options: { allowLoopbackHttp?: boolean; label?: string } = {},
): string {
  const label = options.label || "服务地址";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label}不是有效 URL。`);
  }
  if (url.username || url.password) {
    throw new Error(`${label}不得在 URL 中包含账号或密码。`);
  }
  if (url.hash) throw new Error(`${label}不得包含片段标识。`);
  const loopbackHttp =
    options.allowLoopbackHttp &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(`${label}必须使用 HTTPS；仅本机回环服务可使用 HTTP。`);
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizeSignedHttpsUrl(value: string, label: string): string {
  return normalizeServiceBaseUrl(value, { label });
}

export async function fetchWithTimeout<T>(
  fetchImpl: FetchLike<T>,
  url: string,
  init: RequestInit = {},
  timeoutMs = 60_000,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = globalThis.setTimeout(
    () => controller.abort(new Error("请求超时")),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error("网络请求超时，请稍后重试。", { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function readBoundedArrayBuffer(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label}超过 ${formatMiB(maxBytes)}MB 安全上限。`);
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label}超过 ${formatMiB(maxBytes)}MB 安全上限。`);
    }
    return bytes;
  }

  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("size limit exceeded");
      throw new Error(`${label}超过 ${formatMiB(maxBytes)}MB 安全上限。`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

function formatMiB(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}
