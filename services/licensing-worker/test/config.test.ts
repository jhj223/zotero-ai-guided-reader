import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, type WorkerEnv } from "../src/config";

function validEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    LICENSE_ISSUER: "https://license.example.test",
    LICENSE_AUDIENCE: "zotero-ai-guided-reader",
    LICENSE_KEY_ID: "license-key-2026-08",
    LICENSE_PRIVATE_KEY_PEM:
      "-----BEGIN PRIVATE KEY-----\ntest-only-key-material\n-----END PRIVATE KEY-----",
    SOURCE_URL: "https://github.com/example/licensing-source",
    RATE_LIMIT_PEPPER: "test-only-rate-limit-pepper-32-bytes",
    AFDIAN_USER_ID: "0123456789abcdef0123456789abcdef",
    AFDIAN_API_TOKEN: "test-only-afdian-token-32-bytes-long",
    AFDIAN_MONTHLY_PLAN_ID: "11111111111111111111111111111111",
    AFDIAN_YEARLY_PLAN_ID: "22222222222222222222222222222222",
    ...overrides,
  } as WorkerEnv;
}

describe("loadRuntimeConfig", () => {
  it("loads strict server-owned Afdian plan configuration", () => {
    const config = loadRuntimeConfig(validEnv());

    expect(config.issuer).toBe("https://license.example.test");
    expect(config.monthlyPriceFen).toBe(590);
    expect(config.yearlyPriceFen).toBe(4900);
    expect(config.afdian.monthlyPlanId).toBe(
      "11111111111111111111111111111111",
    );
    expect(config.afdian.yearlyPlanId).toBe("22222222222222222222222222222222");
  });

  it("rejects missing, malformed, and placeholder deployment values", () => {
    expect(() => loadRuntimeConfig(validEnv({ AFDIAN_API_TOKEN: "" }))).toThrow(
      /AFDIAN_API_TOKEN/,
    );
    expect(() =>
      loadRuntimeConfig(validEnv({ AFDIAN_MONTHLY_PLAN_ID: "bad id" })),
    ).toThrow(/AFDIAN_MONTHLY_PLAN_ID/);
    expect(() =>
      loadRuntimeConfig(validEnv({ LICENSE_ISSUER: "http://license.test" })),
    ).toThrow(/LICENSE_ISSUER/);
    expect(() =>
      loadRuntimeConfig(validEnv({ LICENSE_KEY_ID: "replace-me" })),
    ).toThrow(/LICENSE_KEY_ID/);
    expect(() =>
      loadRuntimeConfig(validEnv({ RATE_LIMIT_PEPPER: "short" })),
    ).toThrow(/RATE_LIMIT_PEPPER/);
  });

  it("keeps source and issuer URLs free of credentials and query data", () => {
    expect(() =>
      loadRuntimeConfig(
        validEnv({ SOURCE_URL: "https://user@example.test/source" }),
      ),
    ).toThrow(/SOURCE_URL/);
    expect(() =>
      loadRuntimeConfig(
        validEnv({ LICENSE_ISSUER: "https://license.test/?key=value" }),
      ),
    ).toThrow(/LICENSE_ISSUER/);
  });
});
