/* global Buffer, process */
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [outputArgument, keyIdArgument] = process.argv.slice(2);
if (!outputArgument) {
  throw new Error(
    "Usage: npm run license:keys -- <secure-output-directory> [key-id]",
  );
}
const keyId = keyIdArgument || `license-key-${new Date().getUTCFullYear()}`;
if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) {
  throw new Error("Key ID must contain only letters, numbers, _ or -.");
}

const outputDirectory = resolve(outputArgument);
await mkdir(outputDirectory, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicJwk = await webcrypto.subtle.exportKey(
  "jwk",
  await webcrypto.subtle.importKey(
    "spki",
    pemBody(publicKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  ),
);
if (!publicJwk.n || !publicJwk.e) {
  throw new Error("Generated RSA public key is missing required JWK fields.");
}
const publicRing = {
  [keyId]: {
    kty: "RSA",
    n: publicJwk.n,
    e: publicJwk.e,
    alg: "RS256",
    ext: true,
    key_ops: ["verify"],
  },
};

const privatePath = join(outputDirectory, "license-private.pem");
const publicPath = join(outputDirectory, "license-public.pem");
const ringPath = join(outputDirectory, "license-public-keys.json");
await writeExclusive(privatePath, privateKey);
await writeExclusive(publicPath, publicKey);
await writeExclusive(ringPath, `${JSON.stringify(publicRing, null, 2)}\n`);
await chmod(privatePath, 0o600);

const fingerprint = createHash("sha256")
  .update(publicKey)
  .digest("hex")
  .match(/.{1,4}/g)
  .join(":");
process.stdout.write(
  [
    `Created licensing key pair in ${outputDirectory}`,
    `Key ID: ${keyId}`,
    `Public key SHA-256: ${fingerprint}`,
    "Keep license-private.pem outside Git and the XPI.",
  ].join("\n") + "\n",
);

function pemBody(pem) {
  return Buffer.from(
    pem
      .replace(/-----BEGIN PUBLIC KEY-----/, "")
      .replace(/-----END PUBLIC KEY-----/, "")
      .replace(/\s/g, ""),
    "base64",
  );
}

async function writeExclusive(path, content) {
  await writeFile(path, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
