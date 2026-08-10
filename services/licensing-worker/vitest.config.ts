import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
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
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
