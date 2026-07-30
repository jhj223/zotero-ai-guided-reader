import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreatedPayment,
  PaymentOrderInput,
  PaymentProvider,
} from "./provider.js";

export class SandboxPaymentProvider implements PaymentProvider {
  readonly kind = "sandbox" as const;

  constructor(
    private readonly publicBaseUrl: string,
    private readonly secret: string,
  ) {
    const url = new URL(publicBaseUrl);
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1";
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback)
    ) {
      throw new Error(
        "Sandbox public base URL must use HTTPS or loopback HTTP.",
      );
    }
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Sandbox secret must contain at least 32 bytes.");
    }
  }

  async createPayment(input: PaymentOrderInput): Promise<CreatedPayment> {
    return {
      providerOrderId: `sandbox_${input.orderId}`,
      codeUrl: `${this.publicBaseUrl}/v1/sandbox/pay/${encodeURIComponent(
        input.orderId,
      )}?proof=${encodeURIComponent(this.createProof(input.orderId))}`,
    };
  }

  createProof(orderId: string): string {
    return createHmac("sha256", this.secret)
      .update("sandbox-payment\0", "utf8")
      .update(orderId, "utf8")
      .digest("base64url");
  }

  verifyProof(orderId: string, proof: string): boolean {
    const expected = Buffer.from(this.createProof(orderId), "utf8");
    const received = Buffer.from(proof, "utf8");
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }
}
