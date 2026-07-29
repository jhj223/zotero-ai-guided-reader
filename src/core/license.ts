export const DAY_MS = 24 * 60 * 60 * 1000;

export type LicensePlanId = "trial" | "pro_monthly" | "pro_yearly";
export type EntitlementKind = "trial" | "pro";

export interface EntitlementClaims {
  version: 1;
  issuer: string;
  audience: string;
  tokenId: string;
  deviceId: string;
  kind: EntitlementKind;
  planId: LicensePlanId;
  issuedAt: number;
  offlineUntil: number;
  validUntil: number;
}

export type EntitlementStatus =
  | "trial"
  | "pro"
  | "expired"
  | "refresh_required"
  | "invalid";

export interface EntitlementState {
  status: EntitlementStatus;
  canUsePro: boolean;
  validUntil?: number;
  remainingDays?: number;
}

export function entitlementState(
  claims: EntitlementClaims,
  deviceId: string,
  now: number = Date.now(),
): EntitlementState {
  if (claims.version !== 1 || claims.deviceId !== deviceId) {
    return { status: "invalid", canUsePro: false };
  }
  if (claims.validUntil <= now) {
    return {
      status: "expired",
      canUsePro: false,
      validUntil: claims.validUntil,
      remainingDays: 0,
    };
  }
  if (claims.offlineUntil <= now) {
    return {
      status: "refresh_required",
      canUsePro: false,
      validUntil: claims.validUntil,
      remainingDays: remainingDays(claims.validUntil, now),
    };
  }
  return {
    status: claims.kind,
    canUsePro: true,
    validUntil: claims.validUntil,
    remainingDays: remainingDays(claims.validUntil, now),
  };
}

export function extendEntitlement(
  currentExpiry: number | undefined,
  durationDays: number,
  paidAt: number,
): number {
  const startsAt = Math.max(currentExpiry || 0, paidAt);
  return startsAt + durationDays * DAY_MS;
}

export function formatRemainingDays(
  validUntil: number,
  now = Date.now(),
): string {
  return `剩余 ${remainingDays(validUntil, now)} 天`;
}

function remainingDays(validUntil: number, now: number): number {
  return Math.max(1, Math.ceil((validUntil - now) / DAY_MS));
}
