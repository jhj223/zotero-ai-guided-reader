/* global process, URL */
import { readFile } from "node:fs/promises";

const failures = [];
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const fileConfig = await readOptionalJson("config/commercial-release.json");
const releaseConfig = {
  LICENSE_SERVER_URL:
    process.env.LICENSE_SERVER_URL || fileConfig.licenseServerUrl,
  LICENSE_ISSUER: process.env.LICENSE_ISSUER || fileConfig.licenseIssuer,
  LICENSE_AUDIENCE: process.env.LICENSE_AUDIENCE || fileConfig.licenseAudience,
  LICENSE_PUBLIC_KEYS_JSON:
    process.env.LICENSE_PUBLIC_KEYS_JSON ||
    (fileConfig.licensePublicKeys
      ? JSON.stringify(fileConfig.licensePublicKeys)
      : undefined),
};
if (
  String(packageJson.config?.addonID || "").endsWith("@local") ||
  JSON.stringify(packageJson).includes("github.com/local/")
) {
  failures.push("package metadata still contains local placeholders");
}

for (const name of [
  "LICENSE_SERVER_URL",
  "LICENSE_ISSUER",
  "LICENSE_AUDIENCE",
  "LICENSE_PUBLIC_KEYS_JSON",
]) {
  if (!releaseConfig[name]?.trim()) failures.push(`${name} is not configured`);
}
for (const name of ["LICENSE_SERVER_URL", "LICENSE_ISSUER"]) {
  const value = releaseConfig[name]?.trim();
  if (!value) continue;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.endsWith(".example.com")) {
      failures.push(`${name} must use the real production HTTPS authority`);
    }
  } catch {
    failures.push(`${name} must be a valid URL`);
  }
}
try {
  const ring = JSON.parse(releaseConfig.LICENSE_PUBLIC_KEYS_JSON || "{}");
  if (
    !ring ||
    typeof ring !== "object" ||
    Array.isArray(ring) ||
    Object.keys(ring).length === 0 ||
    Object.entries(ring).some(
      ([keyId, value]) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(keyId) ||
        !value ||
        typeof value !== "object" ||
        value.kty !== "RSA" ||
        typeof value.n !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value.n) ||
        typeof value.e !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value.e),
    )
  ) {
    failures.push(
      "LICENSE_PUBLIC_KEYS_JSON must contain at least one valid RSA key",
    );
  }
} catch {
  failures.push("LICENSE_PUBLIC_KEYS_JSON is invalid JSON");
}
if (
  releaseConfig.LICENSE_AUDIENCE &&
  !/^[A-Za-z0-9._-]{3,128}$/.test(releaseConfig.LICENSE_AUDIENCE)
) {
  failures.push("LICENSE_AUDIENCE is invalid");
}

for (const path of [
  "PRIVACY.md",
  "TERMS_OF_SERVICE.md",
  "TRADEMARKS.md",
  "IP_POLICY.md",
  "SECURITY.md",
]) {
  const text = await readFile(path, "utf8");
  if (/\[(?:发布前)?必须填写[^\]]*\]/.test(text)) {
    failures.push(`${path} still contains required release placeholders`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Commercial release is blocked:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Commercial release configuration is complete.\n");
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
