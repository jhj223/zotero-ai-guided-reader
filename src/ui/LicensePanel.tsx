import React from "react";
import type { LicenseSnapshot } from "../runtime/licenseManager";
import type { LicenseController } from "./useLicenseController";

export function LicensePanel({
  controller,
}: {
  controller: LicenseController;
}) {
  const { snapshot, order, busy, error, message } = controller;
  return (
    <section className="zg-license" aria-label="授权与套餐">
      <div className="zg-license-head">
        <div>
          <strong>{licenseStatusLabel(snapshot)}</strong>
          {snapshot.remainingDays != null && (
            <span> · 剩余 {snapshot.remainingDays} 天</span>
          )}
        </div>
        {snapshot.validUntil != null && (
          <span className="zg-license-expiry">
            有效至 {new Date(snapshot.validUntil).toLocaleDateString()}
          </span>
        )}
      </div>
      {snapshot.message && (
        <div className="zg-license-hint">{snapshot.message}</div>
      )}
      {error && <div className="zg-license-error">{error}</div>}
      {message && <div className="zg-license-message">{message}</div>}

      {snapshot.plans.length > 0 && !order && (
        <div className="zg-plan-grid">
          {snapshot.plans.map((plan) => (
            <button
              key={plan.id}
              disabled={busy}
              onClick={() => void controller.purchase(plan.id)}
            >
              <span>{plan.label}</span>
              <strong>{formatPrice(plan.priceFen)}</strong>
              <small>{plan.durationDays} 天 · 主动扫码续费</small>
            </button>
          ))}
        </div>
      )}

      {order && (
        <div className="zg-payment">
          <img
            src={order.qrDataUrl}
            alt={`${formatPrice(order.amountFen)} 微信支付二维码`}
          />
          <div className="zg-payment-meta">
            <strong>{formatPrice(order.amountFen)}</strong>
            <span>请使用微信扫码，本次付款不会自动续扣。</span>
            <span>
              订单有效至 {new Date(order.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="zg-payment-actions">
            <button
              disabled={busy}
              onClick={() => void controller.refreshOrder()}
            >
              我已支付，刷新状态
            </button>
            <button disabled={busy} onClick={controller.dismissOrder}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function formatPrice(priceFen: number): string {
  return `¥${(priceFen / 100).toFixed(2)}`;
}

function licenseStatusLabel(snapshot: LicenseSnapshot): string {
  switch (snapshot.status) {
    case "loading":
      return "正在检查授权";
    case "trial":
      return "完整试用";
    case "pro":
      return snapshot.planId === "pro_yearly" ? "Pro 年付" : "Pro 月付";
    case "expired":
      return "授权已到期";
    case "refresh_required":
      return "需要联网刷新授权";
    case "unavailable":
      return "授权服务未配置";
    case "invalid":
      return "授权无效";
    default:
      return "授权服务暂时不可用";
  }
}
