/**
 * Business Pulse 合成テスト — node:test（追加依存ゼロ）。
 *
 * 主眼は「欠損を合計に紛れ込ませないこと」と
 * 「HOLD 中の fee/net・会計上の売上を出さないこと」。
 *   npx tsx --test lib/businessPulse.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { composeBusinessPulse } from "./businessPulse.ts";
import { ADMITTED_DELIVERY, findAdmittedDelivery } from "./admittedDelivery.ts";

const START = "2026-08-01";
const END = "2026-08-24";
/** Square に要求する窓。両端固定（8/24 営業日の終わり = 8/25 03:00 JST）。 */
const SQ_WINDOW = {
  start: "2026-08-01T03:00:00+09:00",
  end: "2026-08-25T03:00:00+09:00",
};

/** hardened fetchMtd の戻り値と同型（8月 LIVE 実測値）。 */
function squareOk(overrides = {}) {
  return {
    source: "square",
    fetched_at: "2026-08-25T22:08:13.588Z",
    period_start: SQ_WINDOW.start,
    period_end: SQ_WINDOW.end,
    order_count: 777,
    sales_tax_inclusive: 1617745,
    sales_tax_exclusive: 1471909,
    excluded_return_containers: 2,
    pagination_pages: 2,
    error_state: { state: "OK" },
    ...overrides,
  };
}

function squareFailed(state) {
  return squareOk({
    order_count: null,
    sales_tax_inclusive: null,
    sales_tax_exclusive: null,
    error_state: { state, detail: "x" },
  });
}

const compose = (o = {}) =>
  composeBusinessPulse({
    periodStart: START,
    periodEnd: END,
    squareWindow: SQ_WINDOW,
    square: squareOk(),
    ...o,
  });

/* --- 採択値の再現 ------------------------------------------------------- */

test("exact_platform_totals: 3系統が採択値どおりに出る", () => {
  const p = compose();
  const by = Object.fromEntries(p.platform_breakdown.map((x) => [x.platform, x]));
  assert.deepEqual(
    { orders: by.square.orders, sales: by.square.sales, basis: by.square.basis },
    { orders: 777, sales: 1617745, basis: "TAX_INCLUSIVE" },
  );
  assert.deepEqual(
    { orders: by.uber.orders, sales: by.uber.sales, basis: by.uber.basis },
    { orders: 280, sales: 726750, basis: "TAX_INCLUSIVE" },
  );
  assert.deepEqual(
    { orders: by.rocketnow.orders, sales: by.rocketnow.sales, basis: by.rocketnow.basis },
    { orders: 109, sales: 201200, basis: "PLATFORM_REPORTED_GROSS" },
  );
});

test("exact_combined_total: 1166 件 / 2,545,695 円", () => {
  const p = compose();
  assert.equal(p.orders, 1166);
  assert.equal(p.sales, 2545695);
  assert.equal(p.orders, 777 + 280 + 109);
  assert.equal(p.sales, 1617745 + 726750 + 201200);
});

test("Square は税込を採る（税抜 1,471,909 を合計に入れない）", () => {
  const p = compose();
  assert.notEqual(p.sales, 1471909 + 726750 + 201200);
  assert.equal(p.platform_breakdown.find((x) => x.platform === "square").sales, 1617745);
});

/* --- fail-closed -------------------------------------------------------- */

for (const state of ["CONFIG_MISSING", "API_ERROR", "PAGINATION_ERROR", "MALFORMED_RESPONSE"]) {
  test(`fail_closed: Square ${state} で合計を出さない`, () => {
    const p = compose({ square: squareFailed(state) });
    assert.equal(p.state, "INCOMPLETE");
    assert.equal(p.orders, null);
    assert.equal(p.sales, null);
    assert.equal(p.basis, null);
    assert.notEqual(p.sales, 0);
    // 配達分だけの合計が「売上」として漏れ出さない
    assert.notEqual(p.sales, 726750 + 201200);
    assert.ok(p.unavailable.some((u) => u.includes(state)));
  });
}

test("fail_closed: 採択済み配達スナップショットが無い期間は合計を出さない", () => {
  const p = composeBusinessPulse({
    periodStart: START,
    periodEnd: END,
    squareWindow: SQ_WINDOW,
    square: squareOk(),
    lookupDelivery: () => null,
  });
  assert.equal(p.state, "INCOMPLETE");
  assert.equal(p.sales, null);
  assert.notEqual(p.sales, 1617745, "Square だけの額を全体の売上として出さない");
  assert.ok(p.unavailable[0].includes("no admitted delivery snapshot"));
});

test("fail_closed: 期間が1日でもずれれば採用しない", () => {
  assert.equal(findAdmittedDelivery("2026-08-01", "2026-08-25"), null);
  assert.equal(findAdmittedDelivery("2026-07-01", "2026-07-31"), null);
  assert.notEqual(findAdmittedDelivery(START, END), null);
});

/* --- Square の期間ロック -------------------------------------------------- */

test("period_lock: period_end が 8/25 03:00 JST より後なら採用しない", () => {
  // 窓を閉じずに走らせると period_end は取得時刻になる。
  // その結果は共通期間より広く、配達側と足せない。
  const p = compose({ square: squareOk({ period_end: "2026-08-25T22:08:13.588Z" }) });
  assert.equal(p.state, "INCOMPLETE");
  assert.equal(p.sales, null);
  assert.equal(p.orders, null);
  assert.notEqual(p.sales, 2545695, "期間の違う Square を合計に混ぜない");
  assert.ok(p.unavailable.some((u) => u.includes("period mismatch")));
});

test("period_lock: period_start がずれても採用しない", () => {
  const p = compose({ square: squareOk({ period_start: "2026-08-01T00:00:00+09:00" }) });
  assert.equal(p.state, "INCOMPLETE");
  assert.equal(p.sales, null);
  assert.ok(p.unavailable.some((u) => u.includes("period mismatch")));
});

test("period_lock: 要求した窓と一致していれば採用する", () => {
  const p = compose();
  const sq = p.platform_breakdown.find((x) => x.platform === "square");
  assert.equal(sq.state, "OK");
  assert.equal(sq.orders, 777);
  assert.equal(p.sales, 2545695);
});

test("period_lock: 不一致の理由が要求値と実測値の両方を含む", () => {
  const p = compose({ square: squareOk({ period_end: "2026-08-26T03:00:00+09:00" }) });
  const detail = p.unavailable[0];
  assert.ok(detail.includes("2026-08-25T03:00:00+09:00"), "要求した窓が出ていない");
  assert.ok(detail.includes("2026-08-26T03:00:00+09:00"), "実測の窓が出ていない");
});

/* --- 契約フィールド ------------------------------------------------------ */

test("basis/state/period/fetched_at が常に揃う", () => {
  for (const p of [compose(), compose({ square: squareFailed("API_ERROR") })]) {
    for (const k of [
      "period",
      "fetched_at",
      "state",
      "orders",
      "sales",
      "basis",
      "basis_detail",
      "platform_breakdown",
      "holds",
      "unavailable",
    ]) {
      assert.ok(k in p, `missing field: ${k}`);
    }
    assert.equal(p.period.start, START);
    assert.equal(p.period.end, END);
    assert.equal(p.period.boundary, "03:00_JST");
    assert.equal(p.fetched_at, "2026-08-25T22:08:13.588Z");
  }
});

test("基準が混在していれば MIXED として内訳を残す", () => {
  const p = compose();
  assert.equal(p.basis, "MIXED");
  assert.equal(p.state, "OPERATIONAL_ADMITTED", "揃っていないものを OK と呼ばない");
  assert.deepEqual(p.basis_detail, {
    square: "TAX_INCLUSIVE",
    uber: "TAX_INCLUSIVE",
    rocketnow: "PLATFORM_REPORTED_GROSS",
  });
});

test("全系統が税込に揃えば OK / basis=TAX_INCLUSIVE", () => {
  const p = composeBusinessPulse({
    periodStart: START,
    periodEnd: END,
    squareWindow: SQ_WINDOW,
    square: squareOk(),
    lookupDelivery: () => ({
      period_start: START,
      period_end: END,
      boundary: "03:00_JST",
      admitted_at: "2026-08-26",
      records: [
        { platform: "uber", orders: 280, sales: 726750, basis: "TAX_INCLUSIVE", source: "s" },
        { platform: "rocketnow", orders: 109, sales: 201200, basis: "TAX_INCLUSIVE", source: "s" },
      ],
    }),
  });
  assert.equal(p.basis, "TAX_INCLUSIVE");
  assert.equal(p.state, "OK");
  assert.equal(p.sales, 2545695);
});

test("各内訳が出所を持つ", () => {
  for (const x of compose().platform_breakdown) {
    assert.ok(x.source && x.source.length > 0, `${x.platform} に source が無い`);
  }
});

/* --- HOLD が破られていないこと ------------------------------------------- */

test("fee/net が昇格していない", () => {
  const p = compose();
  const json = JSON.stringify(p);
  assert.equal(p.holds.fee_net, "HOLD");
  for (const x of p.platform_breakdown) {
    assert.equal("fee" in x, false, `${x.platform} に fee がある`);
    assert.equal("net" in x, false, `${x.platform} に net がある`);
  }
  assert.equal("fee" in p, false);
  assert.equal("net" in p, false);
  for (const forbidden of ["feeRate", "profitRate", "leakAmount", "settlement"]) {
    assert.equal(json.includes(forbidden), false, `${forbidden} が出力に含まれている`);
  }
});

test("accounting truth を主張していない", () => {
  const p = compose();
  const json = JSON.stringify(p);
  assert.equal(p.holds.accounting_truth, "HOLD");
  for (const forbidden of ["net_sales", "netSales", "profit", "taxable", "revenue_recognized"]) {
    assert.equal(json.includes(forbidden), false, `${forbidden} が出力に含まれている`);
  }
});

/* --- Uber の来歴 ---------------------------------------------------------- */

test("uber provenance: 出所・照合・裁定・境界が記録されている", () => {
  const uber = ADMITTED_DELIVERY[0].records.find((r) => r.platform === "uber");
  assert.ok(uber.source.includes("order_history_local_v2_2026-08-01_2026-08-24"));
  assert.ok(uber.source.includes("uberOrderHistory"));
  assert.ok(uber.source.includes("03:00 JST"));
  const p = uber.provenance;
  assert.ok(p, "provenance が無い");
  for (const k of ["rows", "reconciliation", "basis_evidence", "ruling", "boundary"]) {
    assert.ok(k in p, `provenance.${k} が無い`);
  }
  // 支払明細との一致が数字つきで残っていること
  assert.ok(p.reconciliation.includes("281"));
  assert.ok(p.reconciliation.includes("728,850"));
  assert.ok(p.reconciliation.includes("EXACT"));
  // failed の扱いが「この8月の採択に限る」と明記されていること
  assert.ok(p.ruling.includes("failed"));
  assert.ok(p.ruling.includes("RATIFIED_FOR_THIS_AUGUST_ADMISSION"));
  assert.ok(p.ruling.includes("2,260"));
  assert.ok(
    p.ruling.includes("not to the adapter"),
    "裁定がアダプタ本体に及ぶと読めてはいけない",
  );
  // 採択値が 03:00 基準側であること
  assert.ok(p.boundary.includes("280"));
  assert.ok(p.boundary.includes("726,750"));
});

test("uber provenance は集計に影響しない", () => {
  const p = compose();
  const uber = p.platform_breakdown.find((x) => x.platform === "uber");
  assert.equal(uber.orders, 280);
  assert.equal(uber.sales, 726750);
  assert.equal("provenance" in uber, false, "内訳に provenance を持ち出さない");
});

test("採択済みスナップショットは 2026-08 の 1 件のみ（暗黙拡大なし）", () => {
  assert.equal(ADMITTED_DELIVERY.length, 1);
  assert.equal(ADMITTED_DELIVERY[0].boundary, "03:00_JST");
  assert.deepEqual(
    ADMITTED_DELIVERY[0].records.map((r) => r.platform).sort(),
    ["rocketnow", "uber"],
  );
});