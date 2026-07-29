export interface PaymentOrderInput {
  orderId: string;
  amountFen: number;
  description: string;
  expiresAt: number;
}

export interface CreatedPayment {
  providerOrderId: string;
  codeUrl: string;
}

export interface PaymentProvider {
  createPayment(input: PaymentOrderInput): Promise<CreatedPayment>;
}
