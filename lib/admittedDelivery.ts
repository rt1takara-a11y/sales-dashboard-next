/**
 * admittedDelivery.ts
 * ===================
 *
 * Business Pulse で採択済みの配達実績スナップショット。
 *
 * なぜ定数なのか:
 *   配達データはブラウザローカルの CSV / Excel で、サーバ側から取得できない
 *   （Square の ai_sales_summary が unknown_fields で明示しているとおり）。
 *   したがって配達分は「取得」ではなく「採択済みの観測結果」として持つ。
 *   推定・補完・再計算はしない。値は Human Principal が採択した数値そのもの。
 *
 * 出所（provenance）:
 *   uber      2439e306-…_order_history_local_v2_2026-08-01_2026-08-24.csv
 *             dashboard-metrics lib/adapters/uberOrderHistory.ts の
 *             financial_order 規則 + 03:00 JST 営業日正規化
 *   rocketnow sales-report(2001)_20260801_20260824.xlsx
 *             dashboard-metrics lib/adapters/rocketNowSettlement.ts
 *             （orders = PAY 件数 / sales = PAY + CANCEL reversal の net）
 *
 * 期間が一致しない問い合わせには答えない。無いものは無いと返す。
 */

/** 金額が何を意味するか。合算前に必ず突き合わせる。 */
export type SalesBasis =
  /** 顧客が実際に支払った額（消費税込）。税区分が出所で確認済み */
  | "TAX_INCLUSIVE"
  /** プラットフォームが「売上」として報告する額。税区分は出所で未確認 */
  | "PLATFORM_REPORTED_GROSS";

export interface AdmittedPlatformRecord {
  platform: string;
  orders: number;
  sales: number;
  basis: SalesBasis;
  /** どのファイルとどの正規化規則から出たか */
  source: string;
  /**
   * この数値が何と突き合わせて確からしいのか。
   * 後から「なぜこの値なのか」を会話ログ抜きで辿れるようにするための記録で、
   * 集計には一切使わない。
   */
  provenance?: Record<string, string>;
}

export interface AdmittedDeliverySnapshot {
  period_start: string;
  period_end: string;
  boundary: string;
  admitted_at: string;
  records: AdmittedPlatformRecord[];
}

/** 唯一の採択済みスナップショット。追加時はここに足す。 */
export const ADMITTED_DELIVERY: readonly AdmittedDeliverySnapshot[] = [
  {
    period_start: "2026-08-01",
    period_end: "2026-08-24",
    boundary: "03:00_JST",
    admitted_at: "2026-08-26",
    records: [
      {
        platform: "uber",
        orders: 280,
        sales: 726750,
        basis: "TAX_INCLUSIVE",
        source:
          "2439e306-…_order_history_local_v2_2026-08-01_2026-08-24.csv " +
          "(41 cols, 284 rows) / dashboard-metrics@3daa88ce " +
          "lib/adapters/uberOrderHistory.ts financial_order rule " +
          "(completed INCLUDED; canceled+customer INCLUDED; canceled+restaurant EXCLUDED) " +
          "+ status=failed INCLUDED per RATIFIED_FOR_THIS_AUGUST_ADMISSION " +
          "+ 03:00 JST business-day normalization via 利用者が注文した時間",
        provenance: {
          rows: "282 completed + 1 canceled/customer + 1 failed = 284",
          // 支払明細と注文履歴が暦日基準で完全一致することを確認済み。
          // failed 1件を含めたときだけ一致するため、課金は成立している。
          reconciliation:
            "order history (calendar-day, failed included) 281 / 728,850 " +
            "== Payment Details report col17 売上（消費税を含む） 281 / 728,850 (EXACT)",
          // 上の一致が、注文単価が税込であることの証拠でもある。
          basis_evidence: "注文単価 total == Payment Details 売上（消費税を含む） → TAX_INCLUSIVE",
          ruling:
            "status=failed (1 order / ¥2,260 / 2026-08-09) RATIFIED_FOR_THIS_AUGUST_ADMISSION. " +
            "The canonical adapter still throws AdapterError on this status; " +
            "the ruling applies to this admission only, not to the adapter.",
          boundary:
            "03:00 JST: 280 orders / 726,750 (calendar-day basis is 281 / 728,850; " +
            "1 order / ¥2,100 at 8/1 00:03 falls to business day 7/31)",
        },
      },
      {
        platform: "rocketnow",
        orders: 109,
        sales: 201200,
        basis: "PLATFORM_REPORTED_GROSS",
        source:
          "sales-report(2001)_20260801_20260824.xlsx / rocketNowSettlement PAY+CANCEL net",
      },
    ],
  },
];

/**
 * 指定期間の採択済みスナップショットを返す。
 * 期間が完全一致しなければ null。近い期間で代用しない。
 */
export function findAdmittedDelivery(
  periodStart: string,
  periodEnd: string,
): AdmittedDeliverySnapshot | null {
  const hit = ADMITTED_DELIVERY.find(
    (s) => s.period_start === periodStart && s.period_end === periodEnd,
  );
  return hit ?? null;
}