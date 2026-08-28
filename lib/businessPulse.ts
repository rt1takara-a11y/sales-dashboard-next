/**
 * businessPulse.ts
 * ================
 *
 * Square（実測）+ 採択済み配達スナップショット → Business Pulse の合成（純関数）。
 *
 * 設計上の不変条件:
 *  - 欠けているものを 0 で埋めない。1 系統でも欠ければ合計は null で state を落とす
 *    （「売れていない」と「読めていない」を同じ画面に出さない）
 *  - fee / net は出さない。HOLD 中の値を構造に置くと採用済みに見えるため、
 *    field 自体を持たせず holds で明示する
 *  - 会計上の売上ではない。純売上・利益・手数料控除後の語を出さない
 *  - basis が揃っていなければ揃っているふりをしない。MIXED として内訳を残す
 */

import type { MtdResult } from "./squareMtd";
import {
  findAdmittedDelivery,
  type AdmittedPlatformRecord,
  type SalesBasis,
} from "./admittedDelivery";

export type PulseState =
  /** 全系統が揃い、基準も単一 */
  | "OK"
  /** 全系統が揃っているが基準が混在。合計は採択値として成立する */
  | "OPERATIONAL_ADMITTED"
  /** 1 系統以上が欠落・失敗。合計を出さない */
  | "INCOMPLETE";

export interface PulsePlatform {
  platform: string;
  orders: number | null;
  sales: number | null;
  basis: SalesBasis | null;
  source: string;
  /** この系統が値を持てたか */
  state: "OK" | "UNAVAILABLE";
  /** UNAVAILABLE のときだけ理由が入る */
  detail?: string;
}

export interface BusinessPulse {
  period: { start: string; end: string; boundary: string };
  fetched_at: string;
  state: PulseState;
  orders: number | null;
  sales: number | null;
  /** 合計の基準。系統間で異なれば "MIXED" */
  basis: SalesBasis | "MIXED" | null;
  basis_detail: Record<string, SalesBasis>;
  platform_breakdown: PulsePlatform[];
  holds: {
    fee_net: "HOLD";
    accounting_truth: "HOLD";
  };
  /** 合計を出さなかった理由。state=INCOMPLETE のときだけ非空 */
  unavailable: string[];
}

export interface ComposeOptions {
  /** 03:00 JST 営業日の期間。Square 側の集計期間と一致していること */
  periodStart: string;
  periodEnd: string;
  /**
   * Square に要求した窓（ISO・両端指定）。返ってきた period_start / period_end が
   * これと一字でも違えば、別の期間を合算していることになるので採用しない。
   */
  squareWindow: { start: string; end: string };
  /** hardened fetchMtd の戻り値 */
  square: MtdResult;
  /** 期間指定で採択済み配達を引く。既定は同梱スナップショット */
  lookupDelivery?: typeof findAdmittedDelivery;
}

const BOUNDARY = "03:00_JST";

/** Square の実測結果を 1 系統分の内訳に落とす。失敗時は値を持たせない。 */
function squarePlatform(
  square: MtdResult,
  window: { start: string; end: string },
): PulsePlatform {
  const unavailable = (detail: string): PulsePlatform => ({
    platform: "square",
    orders: null,
    sales: null,
    basis: null,
    source: "Square Orders API / fetchMtd",
    state: "UNAVAILABLE",
    detail,
  });

  if (square.error_state.state !== "OK") {
    return unavailable(`square ${square.error_state.state}`);
  }
  // 開いた窓（period_end が取得時刻）を共通期間の実測として扱わない。
  if (square.period_start !== window.start || square.period_end !== window.end) {
    return unavailable(
      `square period mismatch: requested ${window.start}..${window.end}, ` +
        `got ${square.period_start}..${square.period_end}`,
    );
  }
  return {
    platform: "square",
    orders: square.order_count,
    // 顧客が実際に支払った額。税抜値は合算に使わない
    sales: square.sales_tax_inclusive,
    basis: "TAX_INCLUSIVE",
    source: "Square Orders API / fetchMtd",
    state: "OK",
  };
}

function deliveryPlatform(record: AdmittedPlatformRecord): PulsePlatform {
  return {
    platform: record.platform,
    orders: record.orders,
    sales: record.sales,
    basis: record.basis,
    source: record.source,
    state: "OK",
  };
}

/** 欠落した配達系統を、値ではなく欠落として表現する。 */
function missingDelivery(periodStart: string, periodEnd: string): PulsePlatform {
  return {
    platform: "delivery",
    orders: null,
    sales: null,
    basis: null,
    source: "admitted delivery snapshot",
    state: "UNAVAILABLE",
    detail: `no admitted delivery snapshot for ${periodStart}..${periodEnd}`,
  };
}

/**
 * Business Pulse を合成する。
 * 1 系統でも UNAVAILABLE なら orders / sales は null のまま state=INCOMPLETE。
 */
export function composeBusinessPulse(options: ComposeOptions): BusinessPulse {
  const lookup = options.lookupDelivery ?? findAdmittedDelivery;
  const snapshot = lookup(options.periodStart, options.periodEnd);

  const platforms: PulsePlatform[] = [
    squarePlatform(options.square, options.squareWindow),
  ];
  if (snapshot) {
    for (const record of snapshot.records) platforms.push(deliveryPlatform(record));
  } else {
    platforms.push(missingDelivery(options.periodStart, options.periodEnd));
  }

  const unavailable = platforms
    .filter((p) => p.state === "UNAVAILABLE")
    .map((p) => p.detail ?? p.platform);

  const basisDetail: Record<string, SalesBasis> = {};
  for (const p of platforms) {
    if (p.state === "OK" && p.basis) basisDetail[p.platform] = p.basis;
  }

  const base: Omit<BusinessPulse, "state" | "orders" | "sales" | "basis"> = {
    period: { start: options.periodStart, end: options.periodEnd, boundary: BOUNDARY },
    fetched_at: options.square.fetched_at,
    basis_detail: basisDetail,
    platform_breakdown: platforms,
    holds: { fee_net: "HOLD", accounting_truth: "HOLD" },
    unavailable,
  };

  if (unavailable.length > 0) {
    // 部分合計は出さない。読めた分だけ足した数は「今月の売上」ではない。
    return { ...base, state: "INCOMPLETE", orders: null, sales: null, basis: null };
  }

  const distinct = [...new Set(Object.values(basisDetail))];
  const basis: SalesBasis | "MIXED" = distinct.length === 1 ? distinct[0] : "MIXED";

  return {
    ...base,
    state: basis === "MIXED" ? "OPERATIONAL_ADMITTED" : "OK",
    orders: platforms.reduce((sum, p) => sum + (p.orders ?? 0), 0),
    sales: platforms.reduce((sum, p) => sum + (p.sales ?? 0), 0),
    basis,
  };
}
