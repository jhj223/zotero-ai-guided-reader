import assert from "node:assert/strict";
import test from "node:test";
import { SemanticClient } from "../src/runtime/semanticClient";

test("Voyage adapter sends query and document embedding input types", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new SemanticClient(
    {
      provider: "voyage",
      apiKey: "secret",
      model: "voyage-4-large",
      baseUrl: "https://api.voyageai.com/v1",
    },
    async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const input = body.input as string[];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: input.map((_text, index) => ({
            index,
            embedding: index === 0 ? [1, 0] : [0.9, 0.1],
          })),
        }),
      } as Response;
    },
  );

  const scores = await client.score("query", ["document"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(calls[0].body.input_type, "query");
  assert.equal(calls[0].body.output_dtype, "float");
  assert.equal(calls[0].body.encoding_format, undefined);
  assert.equal(calls[1].body.input_type, "document");
  assert.ok(scores[0] > 0.99);
});

test("disabled semantic provider performs no request", async () => {
  const client = new SemanticClient(
    { provider: "none", apiKey: "", model: "", baseUrl: "" },
    async () => {
      throw new Error("must not request");
    },
  );
  assert.deepEqual(await client.score("query", ["document"]), []);
});

test("Jina adapter distinguishes retrieval queries from passages", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new SemanticClient(
    {
      provider: "jina",
      apiKey: "secret",
      model: "jina-embeddings-v4",
      baseUrl: "https://api.jina.ai/v1",
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const input = body.input as string[];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: input.map((_text, index) => ({
            index,
            embedding: index === 0 ? [1, 0] : [0.8, 0.2],
          })),
        }),
      } as Response;
    },
  );

  assert.equal((await client.score("query", ["document"])).length, 1);
  assert.equal(bodies[0].task, "retrieval.query");
  assert.equal(bodies[1].task, "retrieval.passage");
  assert.equal(bodies[0].embedding_type, "float");
  assert.equal(bodies[0].encoding_format, undefined);
});

test("Ollama adapter does not require an API key", async () => {
  let authorization = "missing";
  const client = new SemanticClient(
    {
      provider: "ollama",
      apiKey: "",
      model: "nomic-embed-text",
      baseUrl: "http://127.0.0.1:11434",
    },
    async (_url, init) => {
      authorization = String(
        (init?.headers as Record<string, string>)?.Authorization || "",
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [
            [1, 0],
            [0.8, 0.2],
          ],
        }),
      } as Response;
    },
  );
  assert.equal((await client.score("query", ["document"])).length, 1);
  assert.equal(authorization, "");
});
