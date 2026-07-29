import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(serviceRoot, "dist");
if (dirname(dist) !== serviceRoot || basename(dist) !== "dist") {
  throw new Error("Refusing to clean an unexpected build directory.");
}
await rm(dist, { recursive: true, force: true });
