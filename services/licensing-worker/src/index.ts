import { Hono } from "hono";
import type { WorkerEnv } from "./config";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));

export default app;
