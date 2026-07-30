import { readFileSync, statSync } from "node:fs";
import type {
  CreatedPayment,
  PaymentOrderInput,
  PaymentProvider,
} from "./provider.js";

const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export class StaticQrPaymentProvider implements PaymentProvider {
  readonly kind = "wechat-static-qr" as const;

  constructor(private readonly qrDataUrl: string) {
    if (
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(qrDataUrl)
    ) {
      throw new Error("Static QR image data URL is invalid.");
    }
  }

  async createPayment(input: PaymentOrderInput): Promise<CreatedPayment> {
    return {
      providerOrderId: input.orderId,
      qrDataUrl: this.qrDataUrl,
    };
  }
}

export function loadStaticQrDataUrl(path: string): string {
  const metadata = statSync(path);
  if (!metadata.isFile()) {
    throw new Error("Static QR image path must reference a file.");
  }
  if (metadata.size <= 0 || metadata.size > MAX_QR_IMAGE_BYTES) {
    throw new Error("Static QR image must be no larger than 2 MiB.");
  }
  const image = readFileSync(path);
  const mediaType = detectMediaType(image);
  if (!mediaType) {
    throw new Error("Static QR image must be a PNG or JPEG file.");
  }
  return `data:${mediaType};base64,${image.toString("base64")}`;
}

function detectMediaType(
  image: Buffer,
): "image/png" | "image/jpeg" | undefined {
  if (
    image.length >= PNG_SIGNATURE.length &&
    image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return "image/png";
  }
  if (
    image.length >= 3 &&
    image[0] === 0xff &&
    image[1] === 0xd8 &&
    image[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return undefined;
}
