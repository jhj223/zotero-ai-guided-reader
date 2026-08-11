import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("license audit and SBOM cover every shipped runtime", async () => {
  const audit = await read("scripts/audit-runtime-licenses.mjs");
  const sbom = await read("scripts/create-release-sbom.mjs");
  for (const service of ["licensing-worker", "afdian-webhook-relay"]) {
    assert.match(audit, new RegExp(`services/${service}/package-lock\\.json`));
    assert.match(sbom, new RegExp(`services/${service}`));
  }
  assert.match(sbom, /sbom-licensing-worker\.cdx\.json/);
  assert.match(sbom, /sbom-afdian-webhook-relay\.cdx\.json/);
});

test("privacy and notices describe the deployed Afdian Worker truthfully", async () => {
  const privacy = await read("PRIVACY.md");
  const notice = await read("NOTICE");
  const thirdParty = await read("THIRD_PARTY_NOTICES.md");
  assert.doesNotMatch(privacy, /仅在内存中将来源 IP/);
  assert.match(privacy, /不可逆哈希/);
  assert.match(privacy, /客户端版本/);
  assert.doesNotMatch(notice, /WeChat Pay/);
  assert.match(notice, /Afdian/);
  assert.match(thirdParty, /katex\s+\| 0\.18\.4/);
  assert.match(thirdParty, /hono\s+\| 4\.13\.1/);
});

test("CI validates the production Worker and webhook relay", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /npm ci --prefix services\/licensing-worker/);
  assert.match(ci, /npm run license:worker:test/);
  assert.match(ci, /npm audit --prefix services\/licensing-worker/);
  assert.match(ci, /npm audit --prefix services\/afdian-webhook-relay/);
});
