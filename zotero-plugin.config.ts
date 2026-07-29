import { defineConfig } from "zotero-plugin-scaffold";
import { readFileSync } from "node:fs";
import pkg from "./package.json";

const commercialConfig = loadCommercialConfig();
const licensePublicKeys = parseLicensePublicKeys(
  process.env.LICENSE_PUBLIC_KEYS_JSON ||
    (commercialConfig.licensePublicKeys
      ? JSON.stringify(commercialConfig.licensePublicKeys)
      : undefined),
);

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          __licenseServerUrl__: JSON.stringify(
            process.env.LICENSE_SERVER_URL ||
              commercialConfig.licenseServerUrl ||
              "",
          ),
          __licenseIssuer__: JSON.stringify(
            process.env.LICENSE_ISSUER ||
              process.env.LICENSE_SERVER_URL ||
              commercialConfig.licenseIssuer ||
              commercialConfig.licenseServerUrl ||
              "",
          ),
          __licenseAudience__: JSON.stringify(
            process.env.LICENSE_AUDIENCE ||
              commercialConfig.licenseAudience ||
              "zotero-ai-guided-reader",
          ),
          __licensePublicKeys__: JSON.stringify(licensePublicKeys),
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    entries: "test-zotero",
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});

function parseLicensePublicKeys(
  rawValue: string | undefined,
): Record<string, JsonWebKey> {
  if (!rawValue) return {};
  const parsed = JSON.parse(rawValue) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LICENSE_PUBLIC_KEYS_JSON must be a JSON object.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.some(
      ([keyId, value]) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(keyId) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as Record<string, unknown>).kty !== "RSA" ||
        typeof (value as Record<string, unknown>).n !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(
          String((value as Record<string, unknown>).n),
        ) ||
        typeof (value as Record<string, unknown>).e !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(String((value as Record<string, unknown>).e)),
    )
  ) {
    throw new Error("LICENSE_PUBLIC_KEYS_JSON contains an invalid RSA key.");
  }
  return parsed as Record<string, JsonWebKey>;
}

function loadCommercialConfig(): {
  licenseServerUrl?: string;
  licenseIssuer?: string;
  licenseAudience?: string;
  licensePublicKeys?: Record<string, JsonWebKey>;
} {
  try {
    return JSON.parse(
      readFileSync("config/commercial-release.json", "utf8"),
    ) as ReturnType<typeof loadCommercialConfig>;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}
