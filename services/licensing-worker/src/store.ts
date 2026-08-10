export type PaidPlanId = "pro_monthly" | "pro_yearly";
export type OrderStatus = "pending" | "paid" | "expired" | "closed";

export interface EntitlementRecord {
  deviceId: string;
  kind: "trial" | "pro";
  planId: "trial" | PaidPlanId;
  validUntil: number;
  updatedAt: number;
}

export interface StoredOrder {
  id: string;
  customOrderId: string;
  deviceId: string;
  planId: PaidPlanId;
  durationDays: 30 | 365;
  amountFen: number;
  status: OrderStatus;
  pollTokenHash: string;
  providerTransactionId?: string;
  createdAt: number;
  expiresAt: number;
  paidAt?: number;
}

export interface NewOrder extends Omit<StoredOrder, "status"> {
  status?: "pending";
}

export interface VerifiedPaymentInput {
  orderId: string;
  eventId: string;
  providerTransactionId: string;
  amountFen: number;
  paidAt: number;
  receivedAt: number;
  verifiedAt: number;
}

export interface CompletedPayment {
  isReplay: boolean;
  order: StoredOrder;
  entitlement: EntitlementRecord;
}

interface Row {
  [key: string]: unknown;
}

export class LicensingStore {
  constructor(private readonly database: D1Database) {}

  async startTrial(
    deviceId: string,
    startedAt: number,
    validUntil: number,
  ): Promise<EntitlementRecord> {
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO devices (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING",
        )
        .bind(deviceId, startedAt),
      this.database
        .prepare(
          `UPDATE devices
           SET trial_started_at = ?1, trial_expires_at = ?2
           WHERE id = ?3 AND trial_started_at IS NULL`,
        )
        .bind(startedAt, validUntil, deviceId),
      this.database
        .prepare(
          `INSERT INTO entitlements
             (device_id, kind, plan_id, valid_until, updated_at)
           SELECT id, 'trial', 'trial', ?1, ?2 FROM devices WHERE id = ?3
           ON CONFLICT(device_id) DO NOTHING`,
        )
        .bind(validUntil, startedAt, deviceId),
    ]);
    const entitlement = await this.getEntitlement(deviceId);
    if (!entitlement) throw new Error("TRIAL_STATE_UNAVAILABLE");
    return entitlement;
  }

  async createOrder(order: NewOrder): Promise<StoredOrder> {
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO devices (id, created_at) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING",
        )
        .bind(order.deviceId, order.createdAt),
      this.database
        .prepare(
          `INSERT INTO orders
             (id, custom_order_id, device_id, plan_id, duration_days,
              amount_fen, status, poll_token_hash, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9)`,
        )
        .bind(
          order.id,
          order.customOrderId,
          order.deviceId,
          order.planId,
          order.durationDays,
          order.amountFen,
          order.pollTokenHash,
          order.createdAt,
          order.expiresAt,
        ),
    ]);
    const stored = await this.findOrder(order.id);
    if (!stored) throw new Error("ORDER_STATE_UNAVAILABLE");
    return stored;
  }

  async findOrder(orderId: string): Promise<StoredOrder | undefined> {
    const row = await this.database
      .prepare("SELECT * FROM orders WHERE id = ?1")
      .bind(orderId)
      .first<Row>();
    return row ? mapOrder(row) : undefined;
  }

  async findOrderByCustomOrderId(
    customOrderId: string,
  ): Promise<StoredOrder | undefined> {
    const row = await this.database
      .prepare("SELECT * FROM orders WHERE custom_order_id = ?1")
      .bind(customOrderId)
      .first<Row>();
    return row ? mapOrder(row) : undefined;
  }

  async getEntitlement(
    deviceId: string,
  ): Promise<EntitlementRecord | undefined> {
    const row = await this.database
      .prepare("SELECT * FROM entitlements WHERE device_id = ?1")
      .bind(deviceId)
      .first<Row>();
    return row ? mapEntitlement(row) : undefined;
  }

  async completePayment(
    input: VerifiedPaymentInput,
  ): Promise<CompletedPayment> {
    const order = await this.findOrder(input.orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    if (order.amountFen !== input.amountFen) {
      throw new Error("PAYMENT_AMOUNT_MISMATCH");
    }
    if (order.status === "paid") {
      return this.replayedPayment(order, input);
    }
    if (order.status !== "pending" && order.status !== "expired") {
      throw new Error("ORDER_NOT_PENDING");
    }
    if (input.paidAt < order.createdAt || input.paidAt > order.expiresAt) {
      throw new Error("ORDER_PAYMENT_EXPIRED");
    }

    const current = await this.getEntitlement(order.deviceId);
    const validUntil =
      Math.max(current?.validUntil ?? 0, input.paidAt) +
      order.durationDays * 86_400_000;

    try {
      const results = await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO payment_events
               (event_id, order_id, provider_transaction_id, received_at, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(
            input.eventId,
            order.id,
            input.providerTransactionId,
            input.receivedAt,
            input.verifiedAt,
          ),
        this.database
          .prepare(
            `INSERT INTO entitlements
               (device_id, kind, plan_id, valid_until, updated_at)
             VALUES (?1, 'pro', ?2, ?3, ?4)
             ON CONFLICT(device_id) DO UPDATE SET
               kind = 'pro',
               plan_id = excluded.plan_id,
               valid_until = excluded.valid_until,
               updated_at = excluded.updated_at`,
          )
          .bind(order.deviceId, order.planId, validUntil, input.paidAt),
        this.database
          .prepare(
            `UPDATE orders
             SET status = 'paid', provider_transaction_id = ?1, paid_at = ?2
             WHERE id = ?3 AND status IN ('pending', 'expired')`,
          )
          .bind(input.providerTransactionId, input.paidAt, order.id),
      ]);
      if (Number(results[2].meta.changes) !== 1) {
        throw new Error("PAYMENT_CONCURRENT_UPDATE");
      }
    } catch (error) {
      const currentOrder = await this.findOrder(input.orderId);
      if (currentOrder?.status === "paid") {
        return this.replayedPayment(currentOrder, input);
      }
      throw error;
    }

    const completedOrder = await this.findOrder(order.id);
    const entitlement = await this.getEntitlement(order.deviceId);
    if (!completedOrder || !entitlement) {
      throw new Error("PAYMENT_STATE_UNAVAILABLE");
    }
    return { isReplay: false, order: completedOrder, entitlement };
  }

  async listPendingOrders(
    createdAfter: number,
    limit: number,
  ): Promise<StoredOrder[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM orders
         WHERE status = 'pending' AND created_at >= ?1
         ORDER BY created_at ASC LIMIT ?2`,
      )
      .bind(createdAfter, limit)
      .all<Row>();
    return result.results.map(mapOrder);
  }

  async listReconcilableOrders(
    createdAfter: number,
    limit: number,
  ): Promise<StoredOrder[]> {
    const result = await this.database
      .prepare(
        `SELECT * FROM orders
         WHERE status IN ('pending', 'expired') AND created_at >= ?1
         ORDER BY created_at ASC LIMIT ?2`,
      )
      .bind(createdAfter, limit)
      .all<Row>();
    return result.results.map(mapOrder);
  }

  async consumeRateLimit(input: {
    keyHash: string;
    now: number;
    windowMs: number;
    limit: number;
  }): Promise<boolean> {
    const row = await this.database
      .prepare(
        `INSERT INTO rate_limits
           (key_hash, window_started_at, count, expires_at)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN rate_limits.expires_at <= ?2 THEN ?2
             ELSE rate_limits.window_started_at
           END,
           count = CASE
             WHEN rate_limits.expires_at <= ?2 THEN 1
             ELSE rate_limits.count + 1
           END,
           expires_at = CASE
             WHEN rate_limits.expires_at <= ?2 THEN ?3
             ELSE rate_limits.expires_at
           END
         RETURNING count`,
      )
      .bind(input.keyHash, input.now, input.now + input.windowMs)
      .first<Row>();
    return Number(row?.count) <= input.limit;
  }

  async deleteExpiredRateLimits(now: number): Promise<number> {
    const result = await this.database
      .prepare("DELETE FROM rate_limits WHERE expires_at <= ?1")
      .bind(now)
      .run();
    return Number(result.meta.changes);
  }

  async expirePendingOrders(now: number): Promise<number> {
    const result = await this.database
      .prepare(
        "UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?1",
      )
      .bind(now)
      .run();
    return Number(result.meta.changes);
  }

  private async replayedPayment(
    order: StoredOrder,
    input: VerifiedPaymentInput,
  ): Promise<CompletedPayment> {
    const event = await this.database
      .prepare(
        `SELECT event_id, provider_transaction_id
         FROM payment_events WHERE order_id = ?1`,
      )
      .bind(order.id)
      .first<Row>();
    const entitlement = await this.getEntitlement(order.deviceId);
    if (
      order.providerTransactionId !== input.providerTransactionId ||
      event?.event_id !== input.eventId ||
      event?.provider_transaction_id !== input.providerTransactionId ||
      !entitlement
    ) {
      throw new Error("PAYMENT_REPLAY_MISMATCH");
    }
    return { isReplay: true, order, entitlement };
  }
}

function mapOrder(row: Row): StoredOrder {
  return {
    id: String(row.id),
    customOrderId: String(row.custom_order_id),
    deviceId: String(row.device_id),
    planId: String(row.plan_id) as PaidPlanId,
    durationDays: Number(row.duration_days) as 30 | 365,
    amountFen: Number(row.amount_fen),
    status: String(row.status) as OrderStatus,
    pollTokenHash: String(row.poll_token_hash),
    providerTransactionId:
      row.provider_transaction_id == null
        ? undefined
        : String(row.provider_transaction_id),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    paidAt: row.paid_at == null ? undefined : Number(row.paid_at),
  };
}

function mapEntitlement(row: Row): EntitlementRecord {
  return {
    deviceId: String(row.device_id),
    kind: String(row.kind) as EntitlementRecord["kind"],
    planId: String(row.plan_id) as EntitlementRecord["planId"],
    validUntil: Number(row.valid_until),
    updatedAt: Number(row.updated_at),
  };
}
