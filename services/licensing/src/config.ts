export type LicensingConfig =
  | (BaseConfig & {
      paymentProvider: "sandbox";
      sandboxSecret: string;
    })
  | (BaseConfig & {
      paymentProvider: "wechat-static-qr";
      staticQr: {
        imagePath: string;
        watcherPublicKeyPaths: Readonly<Record<string, string>>;
      };
    })
  | (BaseConfig & {
      paymentProvider: "wechat-native";
      wechat: {
        merchantId: string;
        appId: string;
        merchantSerial: string;
        merchantPrivateKeyPath: string;
        apiV3Key: string;
        platformKeyPaths: Readonly<Record<string, string>>;
        notifyUrl: string;
      };
    })
  | (BaseConfig & {
      paymentProvider: "chinaums-qr";
      chinaums: {
        environment: "test" | "production";
        appId: string;
        appKey: string;
        merchantId: string;
        terminalId: string;
        messageSourceId: string;
        notificationKey: string;
        notifyUrl: string;
      };
    });

export interface BaseConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  publicBaseUrl: string;
  sourceUrl: string;
  entitlementIssuer: string;
  entitlementAudience: string;
  entitlementKeyId: string;
  licensePrivateKeyPath?: string;
  licensePublicKeyPath?: string;
  monthlyPriceFen: number;
  yearlyPriceFen: number;
}

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>>,
): LicensingConfig {
  const nodeEnvironment = environment.NODE_ENV || "development";
  if (
    nodeEnvironment !== "development" &&
    nodeEnvironment !== "test" &&
    nodeEnvironment !== "production"
  ) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }
  const publicBaseUrl = parsePublicBaseUrl(
    environment.PUBLIC_BASE_URL || "http://127.0.0.1:8787",
    nodeEnvironment,
  );
  const sourceUrl = parseSourceUrl(
    optionalText(environment.SOURCE_URL) ||
      (nodeEnvironment === "production"
        ? requireText(environment.SOURCE_URL, "SOURCE_URL")
        : "https://github.com/jhj223/zotero-ai-guided-reader"),
  );
  const privateKeyPath = optionalText(environment.LICENSE_PRIVATE_KEY_PATH);
  const publicKeyPath = optionalText(environment.LICENSE_PUBLIC_KEY_PATH);
  if (nodeEnvironment === "production" && (!privateKeyPath || !publicKeyPath)) {
    throw new Error(
      "Production requires license private and public key paths.",
    );
  }

  const base: BaseConfig = {
    environment: nodeEnvironment,
    host:
      optionalText(environment.HOST) ||
      (nodeEnvironment === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: positiveInteger(environment.PORT, 8787, "PORT", 65_535),
    databasePath:
      optionalText(environment.DATABASE_PATH) || "./data/licensing.sqlite",
    publicBaseUrl,
    sourceUrl,
    entitlementIssuer: parseIssuer(
      environment.ENTITLEMENT_ISSUER || publicBaseUrl,
      nodeEnvironment,
    ),
    entitlementAudience: requiredPattern(
      optionalText(environment.ENTITLEMENT_AUDIENCE) ||
        "zotero-ai-guided-reader",
      "ENTITLEMENT_AUDIENCE",
      /^[A-Za-z0-9._-]{3,128}$/,
    ),
    entitlementKeyId: requiredPattern(
      optionalText(environment.ENTITLEMENT_KEY_ID) || "license-key-current",
      "ENTITLEMENT_KEY_ID",
      /^[A-Za-z0-9_-]{1,128}$/,
    ),
    licensePrivateKeyPath: privateKeyPath,
    licensePublicKeyPath: publicKeyPath,
    monthlyPriceFen: positiveInteger(
      environment.MONTHLY_PRICE_FEN,
      1_990,
      "MONTHLY_PRICE_FEN",
    ),
    yearlyPriceFen: positiveInteger(
      environment.YEARLY_PRICE_FEN,
      19_900,
      "YEARLY_PRICE_FEN",
    ),
  };

  const provider =
    optionalText(environment.PAYMENT_PROVIDER) ||
    (nodeEnvironment === "production" ? "wechat-native" : "sandbox");
  if (provider === "sandbox") {
    if (nodeEnvironment === "production") {
      throw new Error("Sandbox payments are forbidden in production.");
    }
    const sandboxSecret = requireText(
      environment.SANDBOX_SECRET,
      "SANDBOX_SECRET",
    );
    if (Buffer.byteLength(sandboxSecret, "utf8") < 32) {
      throw new Error("SANDBOX_SECRET must contain at least 32 bytes.");
    }
    return { ...base, paymentProvider: "sandbox", sandboxSecret };
  }
  if (provider === "wechat-static-qr") {
    return {
      ...base,
      paymentProvider: "wechat-static-qr",
      staticQr: {
        imagePath: requireText(
          environment.WECHAT_STATIC_QR_IMAGE_PATH,
          "WECHAT_STATIC_QR_IMAGE_PATH",
        ),
        watcherPublicKeyPaths: parseKeyPathMap(
          environment.RECEIPT_WATCHER_KEYS_JSON,
          "RECEIPT_WATCHER_KEYS_JSON",
        ),
      },
    };
  }
  if (provider === "chinaums-qr") {
    return {
      ...base,
      paymentProvider: "chinaums-qr",
      chinaums: {
        environment: nodeEnvironment === "production" ? "production" : "test",
        appId: requiredPattern(
          requireText(environment.CHINAUMS_APP_ID, "CHINAUMS_APP_ID"),
          "CHINAUMS_APP_ID",
          /^[A-Za-z0-9_-]{1,32}$/,
        ),
        appKey: requireText(environment.CHINAUMS_APP_KEY, "CHINAUMS_APP_KEY"),
        merchantId: requiredPattern(
          requireText(environment.CHINAUMS_MID, "CHINAUMS_MID"),
          "CHINAUMS_MID",
          /^\d{15}$/,
        ),
        terminalId: requiredPattern(
          requireText(environment.CHINAUMS_TID, "CHINAUMS_TID"),
          "CHINAUMS_TID",
          /^[A-Za-z0-9]{8}$/,
        ),
        messageSourceId: requiredPattern(
          requireText(environment.CHINAUMS_MSG_SRC_ID, "CHINAUMS_MSG_SRC_ID"),
          "CHINAUMS_MSG_SRC_ID",
          /^[A-Za-z0-9]{4}$/,
        ),
        notificationKey: requireText(
          environment.CHINAUMS_NOTIFY_KEY,
          "CHINAUMS_NOTIFY_KEY",
        ),
        notifyUrl: `${publicBaseUrl}/v1/webhooks/chinaums`,
      },
    };
  }
  if (provider !== "wechat-native") {
    throw new Error(
      "PAYMENT_PROVIDER must be sandbox, chinaums-qr, wechat-native, or wechat-static-qr.",
    );
  }
  const apiV3Key = requireText(
    environment.WECHAT_API_V3_KEY,
    "WECHAT_API_V3_KEY",
  );
  if (Buffer.byteLength(apiV3Key, "utf8") !== 32) {
    throw new Error("WECHAT_API_V3_KEY must contain exactly 32 bytes.");
  }
  return {
    ...base,
    paymentProvider: "wechat-native",
    wechat: {
      merchantId: requireText(
        environment.WECHAT_MERCHANT_ID,
        "WECHAT_MERCHANT_ID",
      ),
      appId: requireText(environment.WECHAT_APP_ID, "WECHAT_APP_ID"),
      merchantSerial: requireText(
        environment.WECHAT_MERCHANT_SERIAL,
        "WECHAT_MERCHANT_SERIAL",
      ),
      merchantPrivateKeyPath: requireText(
        environment.WECHAT_MERCHANT_PRIVATE_KEY_PATH,
        "WECHAT_MERCHANT_PRIVATE_KEY_PATH",
      ),
      apiV3Key,
      platformKeyPaths: parseKeyPathMap(
        environment.WECHAT_PLATFORM_KEYS_JSON,
        "WECHAT_PLATFORM_KEYS_JSON",
      ),
      notifyUrl: `${publicBaseUrl}/v1/webhooks/wechat`,
    },
  };
}

function parsePublicBaseUrl(
  rawValue: string,
  environment: BaseConfig["environment"],
): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid URL.");
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (
    url.protocol !== "https:" &&
    !(environment !== "production" && url.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must use HTTPS outside loopback development.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL must not contain credentials or query.");
  }
  return url.toString().replace(/\/$/, "");
}

function parseIssuer(
  rawValue: string,
  environment: BaseConfig["environment"],
): string {
  return parsePublicBaseUrl(rawValue, environment);
}

function parseSourceUrl(rawValue: string): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("SOURCE_URL must be a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("SOURCE_URL must be a valid HTTPS URL.");
  }
  return url.toString().replace(/\/$/, "");
}

function parseKeyPathMap(
  rawValue: string | undefined,
  name: string,
): Readonly<Record<string, string>> {
  const text = requireText(rawValue, name);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must map key IDs to public key paths.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.some(
      ([serial, path]) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(serial) ||
        typeof path !== "string" ||
        path.trim().length === 0,
    )
  ) {
    throw new Error(`${name} must map key IDs to public key paths.`);
  }
  return Object.fromEntries(
    entries.map(([serial, path]) => [serial, String(path).trim()]),
  );
}

function positiveInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
  maximum = 100_000_000,
): number {
  const value =
    rawValue == null || rawValue === "" ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireText(value: string | undefined, name: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function requiredPattern(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`${name} has an invalid format.`);
  }
  return value;
}
