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

export interface StaticQrReceiptInput {
  eventId: string;
  keyId: string;
  sequence: number;
  messageFingerprint: string;
  amountFen: number;
  paidAt: number;
  observedAt: number;
}

export interface StaticQrReceiptResult {
  isReplay: boolean;
  status: "matched" | "unmatched";
  matchedOrderId?: string;
  entitlement?: EntitlementRecord;
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
      CREATE TABLE IF NOT EXISTS receipt_events (
        event_id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        message_fingerprint TEXT NOT NULL UNIQUE,
        amount_fen INTEGER NOT NULL,
        paid_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        matched_order_id TEXT REFERENCES orders(id),
        status TEXT NOT NULL,
        UNIQUE(key_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS receipt_nonces (
        key_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(key_id, nonce_hash)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS watcher_status (
        key_id TEXT PRIMARY KEY,
        watcher_version TEXT NOT NULL,
        state TEXT NOT NULL,
        outbox_pending INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
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

  recordWatcherHeartbeat(input: {
    keyId: string;
    watcherVersion: string;
    state: "healthy" | "parser_paused" | "wechat_offline";
    outboxPending: number;
    receivedAt: number;
    nonceHash: string;
    nonceRetentionMs: number;
  }): void {
    this.inTransaction(() => {
      this.reserveReceiptNonce(
        input.keyId,
        input.nonceHash,
        input.receivedAt,
        input.nonceRetentionMs,
      );
      this.database
        .prepare(
          `INSERT INTO watcher_status
             (key_id, watcher_version, state, outbox_pending, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key_id) DO UPDATE SET
             watcher_version = excluded.watcher_version,
             state = excluded.state,
             outbox_pending = excluded.outbox_pending,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          input.keyId,
          input.watcherVersion,
          input.state,
          input.outboxPending,
          input.receivedAt,
        );
    });
  }

  hasHealthyWatcher(currentTime: number, staleAfterMs: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1
         FROM watcher_status
         WHERE state = 'healthy' AND last_seen_at >= ?
         LIMIT 1`,
      )
      .get(currentTime - staleAfterMs);
    return Boolean(row);
  }

  recordStaticQrReceipt(
    input: StaticQrReceiptInput,
    receivedAt: number,
    nonceHash: string,
    options: {
      nonceRetentionMs: number;
      orderTimeSkewMs: number;
    },
  ): StaticQrReceiptResult {
    return this.inTransaction(() => {
      this.reserveReceiptNonce(
        input.keyId,
        nonceHash,
        receivedAt,
        options.nonceRetentionMs,
      );

      const existing = this.database
        .prepare("SELECT * FROM receipt_events WHERE event_id = ?")
        .get(input.eventId) as DatabaseRow | undefined;
      if (existing) {
        if (!sameReceiptEvent(existing, input)) {
          throw new Error("RECEIPT_EVENT_REPLAY_MISMATCH");
        }
        return this.replayedReceiptResult(existing);
      }

      const conflict = this.database
        .prepare(
          `SELECT 1
           FROM receipt_events
           WHERE (key_id = ? AND sequence = ?)
              OR message_fingerprint = ?
           LIMIT 1`,
        )
        .get(input.keyId, input.sequence, input.messageFingerprint);
      if (conflict) {
        throw new Error("RECEIPT_EVENT_REPLAY_MISMATCH");
      }

      this.database
        .prepare(
          `INSERT INTO receipt_events
             (event_id, key_id, sequence, message_fingerprint, amount_fen,
              paid_at, observed_at, received_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched')`,
        )
        .run(
          input.eventId,
          input.keyId,
          input.sequence,
          input.messageFingerprint,
          input.amountFen,
          input.paidAt,
          input.observedAt,
          receivedAt,
        );

      const candidates = this.database
        .prepare(
          `SELECT *
           FROM orders
           WHERE provider = 'wechat-static-qr'
             AND status = 'pending'
             AND amount_fen = ?
             AND created_at <= ?
             AND expires_at >= ?
           LIMIT 2`,
        )
        .all(
          input.amountFen,
          input.paidAt + options.orderTimeSkewMs,
          input.paidAt - options.orderTimeSkewMs,
        ) as DatabaseRow[];
      if (candidates.length !== 1) {
        return { isReplay: false, status: "unmatched" };
      }

      const order = mapOrder(candidates[0]);
      const paid = this.markPaidInTransaction(
        {
          orderId: order.id,
          transactionId: `static_qr_${input.eventId}`,
          amountFen: input.amountFen,
          paidAt: input.paidAt,
        },
        options.orderTimeSkewMs,
      );
      if (!paid) throw new Error("ORDER_NOT_FOUND");
      this.database
        .prepare(
          `UPDATE receipt_events
           SET status = 'matched', matched_order_id = ?
           WHERE event_id = ?`,
        )
        .run(order.id, input.eventId);
      return {
        isReplay: false,
        status: "matched",
        matchedOrderId: order.id,
        entitlement: paid.entitlement,
      };
    });
  }

  private markPaidInTransaction(
    input: {
      orderId: string;
      transactionId: string;
      amountFen: number;
      paidAt: number;
    },
    expiryGraceMs = 0,
  ):
    | {
        order: StoredOrder;
        entitlement: EntitlementRecord;
      }
    | undefined {
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
    if (input.paidAt > order.expiresAt + expiryGraceMs) {
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

  private reserveReceiptNonce(
    keyId: string,
    nonceHash: string,
    receivedAt: number,
    retentionMs: number,
  ): void {
    this.database
      .prepare("DELETE FROM receipt_nonces WHERE expires_at <= ?")
      .run(receivedAt);
    const nonceInsert = this.database
      .prepare(
        `INSERT OR IGNORE INTO receipt_nonces
           (key_id, nonce_hash, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(keyId, nonceHash, receivedAt + retentionMs);
    if (Number(nonceInsert.changes) === 0) {
      throw new Error("RECEIPT_NONCE_REPLAY");
    }
  }

  private replayedReceiptResult(row: DatabaseRow): StaticQrReceiptResult {
    if (String(row.status) !== "matched") {
      return { isReplay: true, status: "unmatched" };
    }
    const matchedOrderId = stringOrUndefined(row.matched_order_id);
    const order = matchedOrderId ? this.findOrder(matchedOrderId) : undefined;
    const entitlement = order ? this.getEntitlement(order.deviceId) : undefined;
    if (!matchedOrderId || !order || !entitlement) {
      throw new Error("MATCHED_RECEIPT_WITHOUT_ENTITLEMENT");
    }
    return {
      isReplay: true,
      status: "matched",
      matchedOrderId,
      entitlement,
    };
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

function sameReceiptEvent(
  row: DatabaseRow,
  input: StaticQrReceiptInput,
): boolean {
  return (
    String(row.key_id) === input.keyId &&
    Number(row.sequence) === input.sequence &&
    String(row.message_fingerprint) === input.messageFingerprint &&
    Number(row.amount_fen) === input.amountFen &&
    Number(row.paid_at) === input.paidAt &&
    Number(row.observed_at) === input.observedAt
  );
}

function numberOrUndefined(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}
