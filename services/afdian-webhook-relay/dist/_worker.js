const BACKEND_WEBHOOK_URL =
  "https://zotero-ai-guided-reader-licensing.zotero-ai-reader.workers.dev/v1/webhooks/afdian";
const MAX_BODY_BYTES = 64 * 1024;

export function createHandler(fetchImpl = fetch) {
  return async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/afdian") {
      return json({ ec: 404, em: "not found" }, 404);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json({ ec: 413, em: "request too large" }, 413);
    }

    try {
      const response = await fetchImpl(BACKEND_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type":
            request.headers.get("content-type") || "application/json",
          "user-agent": "zotero-ai-afdian-webhook-relay/1.0",
        },
        body,
        redirect: "manual",
      });
      const responseBody = await response.arrayBuffer();
      if (response.status === 400 && isSafeProbeRejection(responseBody)) {
        return json({ ec: 200, em: "" });
      }
      return new Response(responseBody, {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") ||
            "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch {
      return json({ ec: 500, em: "upstream unavailable" }, 502);
    }
  };
}

function isSafeProbeRejection(body) {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return ["INVALID_JSON", "INVALID_WEBHOOK"].includes(value?.error?.code);
  } catch {
    return false;
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

const handleRequest = createHandler();

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
