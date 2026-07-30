export interface PaymentOrderInput {
  orderId: string;
  amountFen: number;
  description: string;
  expiresAt: number;
}

export type PaymentProviderKind =
  | "sandbox"
  | "wechat-native"
  | "wechat-static-qr";

export type CreatedPayment =
  | {
      providerOrderId: string;
      codeUrl: string;
      qrDataUrl?: never;
    }
  | {
      providerOrderId: string;
      qrDataUrl: string;
      codeUrl?: never;
    };

export interface PaymentProvider {
  readonly kind: PaymentProviderKind;
  createPayment(input: PaymentOrderInput): Promise<CreatedPayment>;
}
