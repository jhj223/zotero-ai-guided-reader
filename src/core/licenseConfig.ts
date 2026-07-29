export interface EntitlementPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
  alg?: "RS256";
  ext?: boolean;
  key_ops?: string[];
}

export type LicenseRuntimeConfig =
  | {
      enabled: false;
      reason: string;
    }
  | {
      enabled: true;
      baseUrl: string;
      issuer: string;
      audience: string;
      publicKeys: Readonly<Record<string, EntitlementPublicJwk>>;
      allowLoopbackHttp: boolean;
    };

export function readBundledLicenseConfig(): LicenseRuntimeConfig {
  return normalizeBundledLicenseConfig({
    baseUrl: __licenseServerUrl__,
    issuer: __licenseIssuer__,
    audience: __licenseAudience__,
    publicKeys: __licensePublicKeys__,
    development: __env__ === "development",
  });
}

export function normalizeBundledLicenseConfig(input: {
  baseUrl: string;
  issuer: string;
  audience: string;
  publicKeys: Readonly<Record<string, EntitlementPublicJwk>>;
  development: boolean;
}): LicenseRuntimeConfig {
  if (
    !input.baseUrl.trim() &&
    !input.issuer.trim() &&
    Object.keys(input.publicKeys).length === 0
  ) {
    return {
      enabled: false,
      reason: "当前构建未配置官方授权服务。",
    };
  }
  const baseUrl = normalizeAuthorityUrl(input.baseUrl, input.development);
  const issuer = normalizeAuthorityUrl(input.issuer, input.development);
  if (
    !/^[A-Za-z0-9._-]{3,128}$/.test(input.audience) ||
    Object.keys(input.publicKeys).length === 0
  ) {
    throw new Error("Bundled entitlement authority is invalid.");
  }
  for (const [keyId, jwk] of Object.entries(input.publicKeys)) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(keyId) ||
      jwk.kty !== "RSA" ||
      typeof jwk.n !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(jwk.n) ||
      typeof jwk.e !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(jwk.e)
    ) {
      throw new Error("Bundled entitlement public key is invalid.");
    }
  }
  return {
    enabled: true,
    baseUrl,
    issuer,
    audience: input.audience,
    publicKeys: input.publicKeys,
    allowLoopbackHttp: input.development,
  };
}

function normalizeAuthorityUrl(value: string, development: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bundled entitlement authority URL is invalid.");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";
  if (
    url.protocol !== "https:" &&
    !(development && loopback && url.protocol === "http:")
  ) {
    throw new Error("Bundled entitlement authority must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Bundled entitlement authority URL is invalid.");
  }
  return url.toString().replace(/\/$/, "");
}
