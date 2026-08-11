export interface WorkerEnv {
  DB: D1Database;
  LICENSE_ISSUER: string;
  LICENSE_AUDIENCE: string;
  LICENSE_KEY_ID: string;
  LICENSE_PRIVATE_KEY_PEM: string;
  LICENSE_PREVIOUS_PUBLIC_KEYS_JSON?: string;
  SOURCE_URL: string;
  RATE_LIMIT_PEPPER: string;
  AFDIAN_USER_ID: string;
  AFDIAN_API_TOKEN: string;
  AFDIAN_MONTHLY_PLAN_ID: string;
  AFDIAN_YEARLY_PLAN_ID: string;
}

export interface RuntimeConfig {
  issuer: string;
  audience: string;
  keyId: string;
  privateKeyPem: string;
  previousPublicKeys: Readonly<Record<string, JsonWebKey>>;
  sourceUrl: string;
  rateLimitPepper: string;
  monthlyPriceFen: 590;
  yearlyPriceFen: 4900;
  afdian: {
    userId: string;
    apiToken: string;
    monthlyPlanId: string;
    yearlyPlanId: string;
  };
}

const AFDIAN_ID = /^[0-9a-f]{32}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{3,128}$/;
const PLACEHOLDER = /^(?:change-?me|replace-?me|your[-_]|example[-_])/i;

export function loadRuntimeConfig(env: WorkerEnv): RuntimeConfig {
  const issuer = strictHttpsUrl(env.LICENSE_ISSUER, "LICENSE_ISSUER");
  const sourceUrl = strictHttpsUrl(env.SOURCE_URL, "SOURCE_URL");
  const audience = patterned(
    required(env.LICENSE_AUDIENCE, "LICENSE_AUDIENCE"),
    "LICENSE_AUDIENCE",
    IDENTIFIER,
  );
  const keyId = patterned(
    required(env.LICENSE_KEY_ID, "LICENSE_KEY_ID"),
    "LICENSE_KEY_ID",
    IDENTIFIER,
  );
  rejectPlaceholder(keyId, "LICENSE_KEY_ID");
  const privateKeyPem = required(
    env.LICENSE_PRIVATE_KEY_PEM,
    "LICENSE_PRIVATE_KEY_PEM",
  );
  if (
    !/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(
      privateKeyPem,
    )
  ) {
    throw new Error("LICENSE_PRIVATE_KEY_PEM must be a PKCS8 PEM private key.");
  }
  const rateLimitPepper = required(env.RATE_LIMIT_PEPPER, "RATE_LIMIT_PEPPER");
  if (new TextEncoder().encode(rateLimitPepper).length < 32) {
    throw new Error("RATE_LIMIT_PEPPER must contain at least 32 bytes.");
  }
  rejectPlaceholder(rateLimitPepper, "RATE_LIMIT_PEPPER");
  const apiToken = required(env.AFDIAN_API_TOKEN, "AFDIAN_API_TOKEN");
  if (apiToken.length < 16 || apiToken.length > 256 || /\s/.test(apiToken)) {
    throw new Error("AFDIAN_API_TOKEN has an invalid format.");
  }
  rejectPlaceholder(apiToken, "AFDIAN_API_TOKEN");

  return {
    issuer,
    audience,
    keyId,
    privateKeyPem,
    previousPublicKeys: parsePreviousPublicKeys(
      env.LICENSE_PREVIOUS_PUBLIC_KEYS_JSON,
    ),
    sourceUrl,
    rateLimitPepper,
    monthlyPriceFen: 590,
    yearlyPriceFen: 4900,
    afdian: {
      userId: patterned(
        required(env.AFDIAN_USER_ID, "AFDIAN_USER_ID"),
        "AFDIAN_USER_ID",
        AFDIAN_ID,
      ),
      apiToken,
      monthlyPlanId: patterned(
        required(env.AFDIAN_MONTHLY_PLAN_ID, "AFDIAN_MONTHLY_PLAN_ID"),
        "AFDIAN_MONTHLY_PLAN_ID",
        AFDIAN_ID,
      ),
      yearlyPlanId: patterned(
        required(env.AFDIAN_YEARLY_PLAN_ID, "AFDIAN_YEARLY_PLAN_ID"),
        "AFDIAN_YEARLY_PLAN_ID",
        AFDIAN_ID,
      ),
    },
  };
}

function parsePreviousPublicKeys(
  serialized: string | undefined,
): Readonly<Record<string, JsonWebKey>> {
  const text = serialized?.trim();
  if (!text) return {};
  if (text.length > 64 * 1024) {
    throw new Error("LICENSE_PREVIOUS_PUBLIC_KEYS_JSON is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("LICENSE_PREVIOUS_PUBLIC_KEYS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LICENSE_PREVIOUS_PUBLIC_KEYS_JSON must be an object.");
  }
  const result: Record<string, JsonWebKey> = {};
  for (const [keyId, value] of Object.entries(parsed)) {
    if (
      !IDENTIFIER.test(keyId) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error("LICENSE_PREVIOUS_PUBLIC_KEYS_JSON is invalid.");
    }
    const jwk = value as JsonWebKey;
    if (
      jwk.kty !== "RSA" ||
      typeof jwk.n !== "string" ||
      !/^[A-Za-z0-9_-]{128,1024}$/.test(jwk.n) ||
      typeof jwk.e !== "string" ||
      !/^[A-Za-z0-9_-]{1,16}$/.test(jwk.e) ||
      jwk.d != null ||
      jwk.p != null ||
      jwk.q != null ||
      jwk.dp != null ||
      jwk.dq != null ||
      jwk.qi != null
    ) {
      throw new Error("LICENSE_PREVIOUS_PUBLIC_KEYS_JSON is invalid.");
    }
    result[keyId] = {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      use: "sig",
      ext: true,
      key_ops: ["verify"],
    };
  }
  return result;
}

function strictHttpsUrl(value: string, name: string): string {
  const text = required(value, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  return url.toString().replace(/\/$/, "");
}

function required(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function patterned(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format.`);
  rejectPlaceholder(value, name);
  return value;
}

function rejectPlaceholder(value: string, name: string): void {
  if (PLACEHOLDER.test(value)) {
    throw new Error(`${name} must not use a placeholder value.`);
  }
}
