import { DatabaseSync } from "node:sqlite";
import type { PaymentProviderKind } from "./payments/provider.js";

export interface EntitlementRecord {
  deviceId: string;
  kind: "trial" | "pro";
  planId: "trial" | "pro_monthly" | "pro_yearly";
  validUntil: number;
  updatedAt: number;
}

export interface StoredOrder {
  id: string;
  deviceId: string;
  planId: "pro_monthly" | "pro_yearly";
  durationDays: number;
  provider: PaymentProviderKind | "legacy";
  baseAmountFen: number;
  amountFen: number;
  amountReservedUntil: number;
  status: "pending" | "paid" | "expired" | "closed";
  pollTokenHash: string;
  transactionId?: string;
  createdAt: number;
  expiresAt: number;
  paidAt?: number;
}

interface DatabaseRow {
  [key: string]: unknown;
}

export class LicensingStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        trial_started_at INTEGER,
        trial_expires_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        plan_id TEXT NOT NULL,
        duration_days INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'legacy',
        base_amount_fen INTEGER NOT NULL,
        amount_fen INTEGER NOT NULL,
        amount_reserved_until INTEGER NOT NULL,
        status TEXT NOT NULL,
        poll_token_hash TEXT NOT NULL,
        transaction_id TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paid_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS entitlements (
        device_id TEXT PRIMARY KEY REFERENCES devices(id),
        kind TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        valid_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      ) STRICT;
    `);
    this.migrateOrderColumns();
  }

  startTrial(
    deviceId: string,
    startedAt: number,
    validUntil: number,
  ): EntitlementRecord {
    return this.inTransaction(() => {
      this.ensureDevice(deviceId, startedAt);
      const device = this.database
        .prepare(
          `SELECT trial_started_at, trial_expires_at
           FROM devices WHERE id = ?`,
        )
        .get(deviceId) as DatabaseRow;
      const existingExpiry = numberOrUndefined(device.trial_expires_at);
      const existingStart = numberOrUndefined(device.trial_started_at);
      if (existingExpiry != null && existingStart != null) {
        const current = this.getEntitlement(deviceId);
        if (current) return current;
        return {
          deviceId,
          kind: "trial",
          planId: "trial",
          validUntil: existingExpiry,
          updatedAt: existingStart,
        };
      }
      this.database
        .prepare(
          `UPDATE devices
           SET trial_started_at = ?, trial_expires_at = ?
           WHERE id = ?`,
        )
        .run(startedAt, validUntil, deviceId);
      this.database
        .prepare(
          `INSERT INTO entitlements
             (device_id, kind, plan_id, valid_until, updated_at)
           VALUES (?, 'trial', 'trial', ?, ?)
           ON CONFLICT(device_id) DO NOTHING`,
        )
        .run(deviceId, validUntil, startedAt);
      return {
        deviceId,
        kind: "trial",
        planId: "trial",
        validUntil,
        updatedAt: startedAt,
      };
    });
  }

  insertOrder(order: StoredOrder): StoredOrder {
    return this.inTransaction(() => {
      const storedOrder =
        order.provider === "wechat-static-qr"
          ? this.allocateStaticQrAmount(order)
          : order;
      this.ensureDevice(storedOrder.deviceId, storedOrder.createdAt);
      this.database
        .prepare(
          `INSERT INTO orders
             (id, device_id, plan_id, duration_days, provider,
              base_amount_fen, amount_fen, amount_reserved_until, status,
              poll_token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storedOrder.id,
          storedOrder.deviceId,
          storedOrder.planId,
          storedOrder.durationDays,
          storedOrder.provider,
          storedOrder.baseAmountFen,
          storedOrder.amountFen,
          storedOrder.amountReservedUntil,
          storedOrder.status,
          storedOrder.pollTokenHash,
          storedOrder.createdAt,
          storedOrder.expiresAt,
        );
      return storedOrder;
    });
  }

  findOrder(id: string): StoredOrder | undefined {
    const row = this.database
      .prepare("SELECT * FROM orders WHERE id = ?")
      .get(id) as DatabaseRow | undefined;
    return row ? mapOrder(row) : undefined;
  }

  getEntitlement(deviceId: string): EntitlementRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM entitlements WHERE device_id = ?")
      .get(deviceId) as DatabaseRow | undefined;
    return row ? mapEntitlement(row) : undefined;
  }

  markPaid(input: {
    orderId: string;
    transactionId: string;
    amountFen: number;
    paidAt: number;
  }): { order: StoredOrder; entitlement: EntitlementRecord } | undefined {
    return this.inTransaction(() => this.markPaidInTransaction(input));
  }

  recordWebhookPayment(
    eventId: string,
    receivedAt: number,
    input: {
      orderId: string;
      transactionId: string;
      amountFen: number;
      paidAt: number;
    },
  ): {
    isReplay: boolean;
    entitlement: EntitlementRecord;
  } {
    return this.inTransaction(() => {
      const insert = this.database
        .prepare(
          `INSERT OR IGNORE INTO webhook_events (event_id, received_at)
           VALUES (?, ?)`,
        )
        .run(eventId, receivedAt);
      if (Number(insert.changes) === 0) {
        const order = this.findOrder(input.orderId);
        const entitlement = order
          ? this.getEntitlement(order.deviceId)
          : undefined;
        if (
          order?.status === "paid" &&
          order.transactionId === input.transactionId &&
          entitlement
        ) {
          return { isReplay: true, entitlement };
        }
        throw new Error("WEBHOOK_EVENT_REPLAY_MISMATCH");
      }
      const result = this.markPaidInTransaction(input);
      if (!result) throw new Error("ORDER_NOT_FOUND");
      return { isReplay: false, entitlement: result.entitlement };
    });
  }

  private markPaidInTransaction(input: {
    orderId: string;
    transactionId: string;
    amountFen: number;
    paidAt: number;
  }): { order: StoredOrder; entitlement: EntitlementRecord } | undefined {
    const order = this.findOrder(input.orderId);
    if (!order) return undefined;
    if (order.status === "paid") {
      const entitlement = this.getEntitlement(order.deviceId);
      if (order.transactionId === input.transactionId && entitlement) {
        return { order, entitlement };
      }
      throw new Error("ORDER_ALREADY_PAID");
    }
    if (order.status !== "pending") throw new Error("ORDER_NOT_PENDING");
    if (input.paidAt > order.expiresAt) {
      throw new Error("ORDER_PAYMENT_EXPIRED");
    }
    if (order.amountFen !== input.amountFen) {
      throw new Error("PAYMENT_AMOUNT_MISMATCH");
    }

    const current = this.getEntitlement(order.deviceId);
    const startsAt = Math.max(current?.validUntil || 0, input.paidAt);
    const validUntil = startsAt + order.durationDays * 24 * 60 * 60 * 1000;
    const entitlement: EntitlementRecord = {
      deviceId: order.deviceId,
      kind: "pro",
      planId: order.planId,
      validUntil,
      updatedAt: input.paidAt,
    };

    this.database
      .prepare(
        `INSERT INTO entitlements
           (device_id, kind, plan_id, valid_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           kind = excluded.kind,
           plan_id = excluded.plan_id,
           valid_until = excluded.valid_until,
           updated_at = excluded.updated_at`,
      )
      .run(
        entitlement.deviceId,
        entitlement.kind,
        entitlement.planId,
        entitlement.validUntil,
        entitlement.updatedAt,
      );
    this.database
      .prepare(
        `UPDATE orders
         SET status = 'paid', transaction_id = ?, paid_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.transactionId, input.paidAt, order.id);

    return {
      order: {
        ...order,
        status: "paid",
        transactionId: input.transactionId,
        paidAt: input.paidAt,
      },
      entitlement,
    };
  }

  private ensureDevice(deviceId: string, createdAt: number): void {
    this.database
      .prepare("INSERT OR IGNORE INTO devices (id, created_at) VALUES (?, ?)")
      .run(deviceId, createdAt);
  }

  private allocateStaticQrAmount(order: StoredOrder): StoredOrder {
    const amountIsReserved = this.database.prepare(
      `SELECT 1
       FROM orders
       WHERE provider = 'wechat-static-qr'
         AND amount_fen = ?
         AND amount_reserved_until > ?
       LIMIT 1`,
    );
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = order.baseAmountFen + suffix;
      if (!amountIsReserved.get(candidate, order.createdAt)) {
        return { ...order, amountFen: candidate };
      }
    }
    throw new Error("PAYMENT_SLOTS_BUSY");
  }

  private migrateOrderColumns(): void {
    const columns = new Set(
      (
        this.database
          .prepare("PRAGMA table_info(orders)")
          .all() as DatabaseRow[]
      ).map((row) => String(row.name)),
    );
    if (!columns.has("provider")) {
      this.database.exec(
        "ALTER TABLE orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy'",
      );
    }
    if (!columns.has("base_amount_fen")) {
      this.database.exec(
        "ALTER TABLE orders ADD COLUMN base_amount_fen INTEGER",
      );
      this.database.exec(
        "UPDATE orders SET base_amount_fen = amount_fen WHERE base_amount_fen IS NULL",
      );
    }
    if (!columns.has("amount_reserved_until")) {
      this.database.exec(
        "ALTER TABLE orders ADD COLUMN amount_reserved_until INTEGER",
      );
      this.database.exec(
        "UPDATE orders SET amount_reserved_until = expires_at WHERE amount_reserved_until IS NULL",
      );
    }
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapOrder(row: DatabaseRow): StoredOrder {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    planId: String(row.plan_id) as StoredOrder["planId"],
    durationDays: Number(row.duration_days),
    provider: String(row.provider) as StoredOrder["provider"],
    baseAmountFen: Number(row.base_amount_fen),
    amountFen: Number(row.amount_fen),
    amountReservedUntil: Number(row.amount_reserved_until),
    status: String(row.status) as StoredOrder["status"],
    pollTokenHash: String(row.poll_token_hash),
    transactionId: stringOrUndefined(row.transaction_id),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    paidAt: numberOrUndefined(row.paid_at),
  };
}

function mapEntitlement(row: DatabaseRow): EntitlementRecord {
  return {
    deviceId: String(row.device_id),
    kind: String(row.kind) as EntitlementRecord["kind"],
    planId: String(row.plan_id) as EntitlementRecord["planId"],
    validUntil: Number(row.valid_until),
    updatedAt: Number(row.updated_at),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
