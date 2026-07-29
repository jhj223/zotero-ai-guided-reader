/* global process */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const buildDirectory = resolve(".scaffold/build");
await mkdir(buildDirectory, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Run this script through npm run release:sbom.");
}
const targets = [
  {
    directory: resolve("."),
    output: resolve(buildDirectory, "sbom-plugin.cdx.json"),
  },
  {
    directory: resolve("services/licensing"),
    output: resolve(buildDirectory, "sbom-licensing-service.cdx.json"),
  },
];

for (const target of targets) {
  const raw = execFileSync(
    process.execPath,
    [
      npmCli,
      "sbom",
      "--sbom-format=cyclonedx",
      "--package-lock-only",
      "--omit=dev",
    ],
    {
      cwd: target.directory,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const sbom = JSON.parse(raw);
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error(
      `npm returned an invalid CycloneDX SBOM for ${target.directory}`,
    );
  }
  await writeFile(target.output, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${target.output}\n`);
}
