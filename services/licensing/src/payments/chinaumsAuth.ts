import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ChinaumsBodySignatureInput {
  appId: string;
  appKey: string;
  timestamp: string;
  nonce: string;
  body: string;
}

export function createChinaumsBodySignature(
  input: ChinaumsBodySignatureInput,
): string {
  validateAuthInput(input);
  const bodyHash = createHash("sha256")
    .update(input.body, "utf8")
    .digest("hex");
  return createHmac("sha256", input.appKey)
    .update(input.appId + input.timestamp + input.nonce + bodyHash, "utf8")
    .digest("base64");
}

export function createChinaumsAuthorization(
  input: ChinaumsBodySignatureInput,
): string {
  const signature = createChinaumsBodySignature(input);
  return (
    `OPEN-BODY-SIG AppId="${input.appId}",` +
    `Timestamp="${input.timestamp}",` +
    `Nonce="${input.nonce}",` +
    `Signature="${signature}"`
  );
}

export function createChinaumsNotificationSignature(
  fields: Iterable<readonly [string, string]>,
  notificationKey: string,
): string {
  if (
    notificationKey.length === 0 ||
    Buffer.byteLength(notificationKey, "utf8") > 1_024
  ) {
    throw new Error("ChinaUMS notification key has an invalid length.");
  }
  const canonical = [...fields]
    .filter(([key]) => key !== "sign")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha256")
    .update(canonical + notificationKey, "utf8")
    .digest("hex")
    .toUpperCase();
}

export function verifyChinaumsNotificationSignature(
  fields: Iterable<readonly [string, string]>,
  notificationKey: string,
  signature: string,
): boolean {
  if (!/^[A-Fa-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(
    createChinaumsNotificationSignature(fields, notificationKey),
    "ascii",
  );
  const received = Buffer.from(signature.toUpperCase(), "ascii");
  return timingSafeEqual(expected, received);
}

function validateAuthInput(input: ChinaumsBodySignatureInput): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.appId)) {
    throw new Error("ChinaUMS AppId has an invalid format.");
  }
  if (!/^\d{14}$/.test(input.timestamp)) {
    throw new Error("ChinaUMS timestamp has an invalid format.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.nonce)) {
    throw new Error("ChinaUMS nonce has an invalid format.");
  }
  if (
    input.appKey.length === 0 ||
    Buffer.byteLength(input.appKey, "utf8") > 1_024
  ) {
    throw new Error("ChinaUMS AppKey has an invalid length.");
  }
}
