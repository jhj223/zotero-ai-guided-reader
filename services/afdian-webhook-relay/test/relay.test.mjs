/* global Request, Response, TextDecoder */
import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "../dist/_worker.js";

test("returns a health response", async () => {
  const response = await createHandler()(
    new Request("https://relay.example/healthz"),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("rejects unrelated routes", async () => {
  const response = await createHandler()(
    new Request("https://relay.example/other"),
  );

  assert.equal(response.status, 404);
});

test("forwards webhook bodies and returns the upstream response", async () => {
  let forwardedRequest;
  const handler = createHandler(async (url, init) => {
    forwardedRequest = { url, init };
    return Response.json({ ec: 200, em: "" });
  });
  const payload = JSON.stringify({ ec: 200, data: { type: "order" } });

  const response = await handler(
    new Request("https://relay.example/webhooks/afdian", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ec: 200, em: "" });
  assert.equal(forwardedRequest.init.method, "POST");
  assert.equal(
    forwardedRequest.url,
    "https://zotero-ai-guided-reader-licensing.zotero-ai-reader.workers.dev/v1/webhooks/afdian",
  );
  assert.equal(new TextDecoder().decode(forwardedRequest.init.body), payload);
});

test("rejects oversized webhook bodies", async () => {
  const response = await createHandler()(
    new Request("https://relay.example/webhooks/afdian", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    }),
  );

  assert.equal(response.status, 413);
});

test("acknowledges Afdian URL probes without granting anything", async () => {
  const handler = createHandler(async () =>
    Response.json(
      { error: { code: "INVALID_WEBHOOK", message: "invalid" } },
      { status: 400 },
    ),
  );

  const response = await handler(
    new Request("https://relay.example/webhooks/afdian", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ec: 200, em: "" });
});

test("does not hide upstream outages", async () => {
  const handler = createHandler(async () =>
    Response.json(
      { error: { code: "INTERNAL", message: "unavailable" } },
      { status: 503 },
    ),
  );

  const response = await handler(
    new Request("https://relay.example/webhooks/afdian", {
      method: "POST",
      body: "{}",
    }),
  );

  assert.equal(response.status, 503);
});
