export interface WorkerEnv {
  DB: D1Database;
  LICENSE_ISSUER: string;
  LICENSE_AUDIENCE: string;
  LICENSE_KEY_ID: string;
  LICENSE_PRIVATE_KEY_PEM: string;
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
