/* global process */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "Zlib",
  "(MIT OR GPL-3.0-or-later)",
  "(MIT AND Zlib)",
]);

const manifests = [
  ["plugin", resolve("package-lock.json")],
  ["licensing-service", resolve("services/licensing/package-lock.json")],
];

const findings = [];
const packages = [];

for (const [scope, lockPath] of manifests) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    findings.push(`${scope}: unsupported package-lock format`);
    continue;
  }
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || metadata.dev === true) continue;
    const name = path.slice("node_modules/".length);
    const license = metadata.license;
    packages.push({
      scope,
      name,
      version: metadata.version ?? "unknown",
      license: license ?? "MISSING",
    });
    if (typeof license !== "string" || !ALLOWED_LICENSES.has(license)) {
      findings.push(
        `${scope}: ${name}@${metadata.version ?? "unknown"} uses ${
          license ?? "an undeclared license"
        }`,
      );
    }
  }
}

packages.sort(
  (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
);
for (const item of packages) {
  process.stdout.write(
    `${item.scope}\t${item.name}@${item.version}\t${item.license}\n`,
  );
}

if (findings.length > 0) {
  process.stderr.write(
    `\nRuntime license audit failed:\n${findings
      .map((finding) => `- ${finding}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\nRuntime license audit passed for ${packages.length} packages.\n`,
  );
}
