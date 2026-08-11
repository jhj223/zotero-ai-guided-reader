import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWithTimeout,
  normalizeServiceBaseUrl,
  normalizeSignedHttpsUrl,
  readBoundedArrayBuffer,
} from "../src/runtime/networkSafety";

test("requires HTTPS except for explicit loopback services", () => {
  assert.equal(
    normalizeServiceBaseUrl("https://api.example.test/v1/"),
    "https://api.example.test/v1",
  );
  assert.equal(
    normalizeServiceBaseUrl("http://127.0.0.1:11434", {
      allowLoopbackHttp: true,
    }),
    "http://127.0.0.1:11434",
  );
  assert.throws(() => normalizeServiceBaseUrl("http://api.example.test"));
  assert.throws(() =>
    normalizeServiceBaseUrl("https://secret@example.test/v1"),
  );
  assert.throws(() =>
    normalizeSignedHttpsUrl("file:///tmp/result.zip", "结果"),
  );
});

test("aborts stalled outbound requests after the configured deadline", async () => {
  let aborted = false;
  await assert.rejects(
    fetchWithTimeout(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      "https://api.example.test",
      {},
      5,
    ),
    /超时/,
  );
  assert.equal(aborted, true);
});

test("rejects a streamed download after it crosses its byte limit", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }),
  );
  await assert.rejects(readBoundedArrayBuffer(response, 5, "测试文件"), /上限/);
});
