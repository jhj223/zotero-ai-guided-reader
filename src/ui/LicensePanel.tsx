import React from "react";
import type { LicenseSnapshot } from "../runtime/licenseManager";
import type { LicenseController } from "./useLicenseController";

const POLICY_BASE =
  "https://github.com/jhj223/zotero-ai-guided-reader/blob/main";

export function LicensePanel({
  controller,
  compact = false,
  onManage,
}: {
  controller: LicenseController;
  compact?: boolean;
  onManage?: () => void;
}) {
  const { snapshot, order, busy, error, message } = controller;
  return (
    <>
      <style>{licensePanelStyles}</style>
      <section
        className={`zg-license${compact ? " zg-license-compact" : ""}`}
        aria-label="授权与套餐"
      >
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
          {compact && onManage && (
            <button
              type="button"
              className="zg-license-manage"
              onClick={onManage}
            >
              管理订阅
            </button>
          )}
        </div>
        {snapshot.message && (
          <div className="zg-license-hint">{snapshot.message}</div>
        )}
        {error && <div className="zg-license-error">{error}</div>}
        {message && <div className="zg-license-message">{message}</div>}

        {!compact && snapshot.plans.length > 0 && !order && (
          <>
            <div className="zg-plan-grid">
              {snapshot.plans.map((plan) => (
                <button
                  key={plan.id}
                  disabled={busy}
                  onClick={() => void controller.purchase(plan.id)}
                >
                  <span>{plan.label}</span>
                  <strong>{formatPrice(plan.priceFen)}</strong>
                  <small>{plan.durationDays} 天 · 手动续费</small>
                </button>
              ))}
            </div>
            <div className="zg-license-policies">
              购买前请阅读
              <button
                type="button"
                onClick={() => openPolicy("TERMS_OF_SERVICE.md")}
              >
                付费服务条款
              </button>
              和
              <button type="button" onClick={() => openPolicy("PRIVACY.md")}>
                隐私政策
              </button>
              。付款不自动续费。
            </div>
          </>
        )}

        {!compact &&
          snapshot.plans.length === 0 &&
          !order &&
          snapshot.status !== "loading" &&
          snapshot.status !== "unavailable" && (
            <button
              type="button"
              className="zg-license-retry"
              disabled={busy}
              onClick={() => void controller.retryLicense()}
            >
              重试获取套餐
            </button>
          )}

        {!compact && order && (
          <div
            className={`zg-payment${order.checkoutUrl ? " zg-payment-link" : ""}`}
          >
            {order.qrDataUrl && (
              <img
                src={order.qrDataUrl}
                alt={`${formatPrice(order.amountFen)} 付款二维码`}
              />
            )}
            <div className="zg-payment-meta">
              <strong>{formatPrice(order.amountFen)}</strong>
              <span>
                请打开爱发电付款页或扫码完成付款，本次付款不会自动续扣。
              </span>
              <span>
                订单有效至 {new Date(order.expiresAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="zg-payment-actions">
              {order.checkoutUrl && (
                <button disabled={busy} onClick={controller.openCheckout}>
                  打开爱发电付款
                </button>
              )}
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
    </>
  );
}

const licensePanelStyles = `
.zg-license { background: #f7fafc; border: 1px solid #d3dce6; border-radius: 8px; box-sizing: border-box; margin-bottom: 10px; min-width: 0; overflow: visible; padding: 10px; }
.zg-license button { background: #f7f9fb; border: 1px solid #c8d0da; border-radius: 6px; color: #202124; cursor: pointer; font: inherit; }
.zg-license button:disabled { cursor: not-allowed; opacity: .55; }
.zg-license-head { align-items: center; display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: space-between; min-width: 0; }
.zg-license-expiry, .zg-license-hint { color: #647282; font-size: 11px; overflow-wrap: anywhere; }
.zg-license-error, .zg-license-message { border-radius: 5px; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; padding: 5px 7px; }
.zg-license-error { background: #fff1f1; color: #8a1f1f; }
.zg-license-message { background: #edf8f1; color: #24533a; }
.zg-license-manage { flex: 0 0 auto; height: auto !important; min-height: 28px; padding: 4px 10px; white-space: nowrap; }
.zg-license-retry { height: auto !important; margin-top: 8px; min-height: 32px; padding: 5px 10px; width: 100%; }
.zg-plan-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); margin-top: 9px; min-width: 0; }
.zg-plan-grid button { align-items: flex-start; box-sizing: border-box; display: flex; flex-direction: column; height: auto !important; min-height: 72px; min-width: 0; padding: 8px 10px; text-align: left; }
.zg-plan-grid button span, .zg-plan-grid button strong, .zg-plan-grid button small { max-width: 100%; overflow-wrap: anywhere; }
.zg-plan-grid button strong { color: #174f86; font-size: 16px; line-height: 1.4; }
.zg-plan-grid button small { color: #647282; font-size: 11px; line-height: 1.4; }
.zg-license-policies { color: #647282; font-size: 11px; line-height: 1.5; margin-top: 7px; }
.zg-license-policies button { background: transparent; border: 0; color: #174f86; display: inline; height: auto !important; min-height: 0; padding: 0 2px; text-decoration: underline; }
.zg-payment { align-items: center; display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(136px, 100%), 1fr)); margin-top: 10px; min-width: 0; }
.zg-payment-link { grid-template-columns: minmax(0, 1fr); }
.zg-payment img { background: white; border: 1px solid #d3dce6; box-sizing: border-box; display: block; height: auto; max-width: 100%; width: 136px; }
.zg-payment-meta { display: flex; flex-direction: column; min-width: 0; }
.zg-payment-meta span { color: #647282; font-size: 11px; overflow-wrap: anywhere; }
.zg-payment-actions { display: grid; gap: 6px; grid-column: 1 / -1; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); min-width: 0; }
.zg-payment-actions button { height: auto !important; min-height: 32px; white-space: normal; }
`;

export function formatPrice(priceFen: number): string {
  return `¥${(priceFen / 100).toFixed(2)}`;
}

function openPolicy(file: "TERMS_OF_SERVICE.md" | "PRIVACY.md"): void {
  Zotero.launchURL(`${POLICY_BASE}/${file}`);
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
