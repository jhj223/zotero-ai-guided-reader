import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyLike,
} from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { LicensingStore } from "./database.js";
import { LicensingService, type Plan } from "./domain.js";
import { EntitlementSigner } from "./entitlements.js";
import { ChinaumsQrProvider } from "./payments/chinaumsQr.js";
import { ChinaumsWebhookProcessor } from "./payments/chinaumsWebhook.js";
import { SandboxPaymentProvider } from "./payments/sandbox.js";
import {
  StaticQrPaymentProvider,
  loadStaticQrDataUrl,
} from "./payments/staticQr.js";
import { StaticQrBridge } from "./payments/staticQrBridge.js";
import {
  WechatNativeProvider,
  type DirectWechatNativeConfig,
} from "./payments/wechatNative.js";
import { WechatWebhookProcessor } from "./payments/wechatWebhook.js";
import { createLicensingServer } from "./server.js";

const runtimeEnvironment: Record<string, string | undefined> = {
  ...process.env,
};
if (
  runtimeEnvironment.NODE_ENV !== "production" &&
  !runtimeEnvironment.SANDBOX_SECRET
) {
  runtimeEnvironment.SANDBOX_SECRET = randomBytes(32).toString("base64url");
}
const config = loadConfig(runtimeEnvironment);
const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
const store = new LicensingStore(database);
const plans: readonly Plan[] = [
  {
    id: "pro_monthly",
    label: "Pro 月付",
    durationDays: 30,
    priceFen: config.monthlyPriceFen,
  },
  {
    id: "pro_yearly",
    label: "Pro 年付",
    durationDays: 365,
    priceFen: config.yearlyPriceFen,
  },
];
const licensing = new LicensingService({
  store,
  plans,
  now: Date.now,
  randomId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
});

const signingKeys = loadSigningKeys(config);
const signer = new EntitlementSigner(
  signingKeys.privateKey,
  signingKeys.publicKey,
  {
    keyId: config.entitlementKeyId,
    issuer: config.entitlementIssuer,
    audience: config.entitlementAudience,
    randomTokenId: () => `ent_${randomUUID().replaceAll("-", "")}`,
  },
);

let sandboxPaymentProvider: SandboxPaymentProvider | undefined;
let staticQrBridge: StaticQrBridge | undefined;
let webhookProcessor: WechatWebhookProcessor | undefined;
let chinaumsPaymentProvider: ChinaumsQrProvider | undefined;
let chinaumsWebhookProcessor: ChinaumsWebhookProcessor | undefined;
const paymentProvider =
  config.paymentProvider === "sandbox"
    ? (sandboxPaymentProvider = new SandboxPaymentProvider(
        config.publicBaseUrl,
        config.sandboxSecret,
      ))
    : config.paymentProvider === "wechat-static-qr"
      ? (() => {
          const watcherPublicKeys = new Map<string, KeyLike>(
            Object.entries(config.staticQr.watcherPublicKeyPaths).map(
              ([keyId, path]) => [keyId, readFileSync(resolve(path), "utf8")],
            ),
          );
          staticQrBridge = new StaticQrBridge({
            store,
            licensing,
            watcherPublicKeys,
          });
          return new StaticQrPaymentProvider(
            loadStaticQrDataUrl(resolve(config.staticQr.imagePath)),
          );
        })()
      : config.paymentProvider === "wechat-native"
        ? (() => {
            const platformPublicKeys = new Map<string, KeyLike>(
              Object.entries(config.wechat.platformKeyPaths).map(
                ([serial, path]) => [
                  serial,
                  readFileSync(resolve(path), "utf8"),
                ],
              ),
            );
            const wechatConfig: DirectWechatNativeConfig = {
              mode: "direct",
              merchantId: config.wechat.merchantId,
              appId: config.wechat.appId,
              merchantSerial: config.wechat.merchantSerial,
              merchantPrivateKey: readFileSync(
                resolve(config.wechat.merchantPrivateKeyPath),
                "utf8",
              ),
              apiV3Key: config.wechat.apiV3Key,
              notifyUrl: config.wechat.notifyUrl,
              platformPublicKeys,
            };
            webhookProcessor = new WechatWebhookProcessor(
              {
                merchantId: wechatConfig.merchantId,
                appId: wechatConfig.appId,
                apiV3Key: wechatConfig.apiV3Key,
                platformPublicKeys,
              },
              licensing,
            );
            return new WechatNativeProvider(wechatConfig);
          })()
        : (() => {
            chinaumsPaymentProvider = new ChinaumsQrProvider({
              environment: config.chinaums.environment,
              appId: config.chinaums.appId,
              appKey: config.chinaums.appKey,
              merchantId: config.chinaums.merchantId,
              terminalId: config.chinaums.terminalId,
              messageSourceId: config.chinaums.messageSourceId,
              notifyUrl: config.chinaums.notifyUrl,
            });
            chinaumsWebhookProcessor = new ChinaumsWebhookProcessor(
              {
                merchantId: config.chinaums.merchantId,
                terminalId: config.chinaums.terminalId,
                notificationKey: config.chinaums.notificationKey,
              },
              licensing,
            );
            return chinaumsPaymentProvider;
          })();

const server = createLicensingServer({
  licensing,
  signer,
  paymentProvider,
  sandboxPaymentProvider,
  staticQrBridge,
  webhookProcessor,
  chinaumsPaymentProvider,
  chinaumsWebhookProcessor,
  sourceUrl: config.sourceUrl,
});
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Licensing service listening on ${config.host}:${config.port} (${config.paymentProvider}).\n`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`Received ${signal}; shutting down.\n`);
  server.close(() => {
    database.close();
    process.exitCode = 0;
  });
  setTimeout(() => {
    process.exitCode = 1;
    process.exit();
  }, 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function loadSigningKeys(current: typeof config): {
  privateKey: KeyLike;
  publicKey: KeyLike;
} {
  if (current.licensePrivateKeyPath && current.licensePublicKeyPath) {
    return {
      privateKey: readFileSync(resolve(current.licensePrivateKeyPath), "utf8"),
      publicKey: readFileSync(resolve(current.licensePublicKeyPath), "utf8"),
    };
  }
  if (current.environment === "production") {
    throw new Error("Production signing keys are not configured.");
  }
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}
