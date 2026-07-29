import { useCallback, useEffect, useMemo, useState } from "react";
import type { LicenseOrder, PaidPlanId } from "../runtime/licenseClient";
import {
  getLicenseManager,
  type LicenseSnapshot,
} from "../runtime/licenseManager";

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLING_MS = 5 * 60 * 1000;

export interface LicenseController {
  snapshot: LicenseSnapshot;
  order?: LicenseOrder;
  busy: boolean;
  error: string;
  message: string;
  purchase(planId: PaidPlanId): Promise<void>;
  refreshOrder(): Promise<void>;
  dismissOrder(): void;
}

export function useLicenseController(): LicenseController {
  const manager = useMemo(() => getLicenseManager(), []);
  const [snapshot, setSnapshot] = useState(manager.current());
  const [order, setOrder] = useState<LicenseOrder>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void manager
      .initialize(controller.signal)
      .then(setSnapshot)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(describeError(reason));
      });
    return () => controller.abort();
  }, [manager]);

  const pollOnce = useCallback(
    async (currentOrder: LicenseOrder, signal?: AbortSignal) => {
      const result = await manager.pollOrder(currentOrder, signal);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        setOrder(undefined);
        setError("");
        setMessage("支付已确认，Pro 权益已自动开通。");
        return true;
      }
      return result.order.status !== "pending";
    },
    [manager],
  );

  useEffect(() => {
    if (!order) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        void pollOnce(order, controller.signal)
          .then((finished) => {
            if (finished || controller.signal.aborted) return;
            if (
              Date.now() - startedAt >= MAX_POLLING_MS ||
              Date.now() >= Date.parse(order.expiresAt)
            ) {
              setError("订单轮询已停止，请重新下单或手动刷新。");
              return;
            }
            schedule();
          })
          .catch((reason) => {
            if (controller.signal.aborted) return;
            setError(describeError(reason));
            if (Date.now() - startedAt < MAX_POLLING_MS) schedule();
          });
      }, POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [order, pollOnce]);

  const purchase = useCallback(
    async (planId: PaidPlanId) => {
      setBusy(true);
      setError("");
      setMessage("");
      try {
        setOrder(await manager.createOrder(planId));
      } catch (reason) {
        setError(describeError(reason));
      } finally {
        setBusy(false);
      }
    },
    [manager],
  );

  const refreshOrder = useCallback(async () => {
    if (!order) return;
    setBusy(true);
    setError("");
    try {
      const finished = await pollOnce(order);
      if (!finished) setMessage("暂未收到支付确认，将继续自动刷新。");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }, [order, pollOnce]);

  return {
    snapshot,
    order,
    busy,
    error,
    message,
    purchase,
    refreshOrder,
    dismissOrder: () => setOrder(undefined),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "授权服务暂时不可用，请稍后重试。";
}
