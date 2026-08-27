/**
 * Square LIVE MTD tests — node:test（追加依存ゼロ）。
 *
 * 主眼は「欠損を 0 円に見せないこと」。
 *   node --test lib/squareMtd.test.mjs   ※ .ts は tsx 経由で読む
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  businessDateJst,
  fetchMtd,
  mtdPeriodStart,
} from "./squareMtd.ts";

const TOKEN = "test-token";
const LOCATION = "test-location";

/** ページ列を順に返す偽 fetch。cursor を送ってきたかも記録する。 */
function fakeFetch(pages) {
  const sentCursors = [];
  let call = 0;
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sentCursors.push(body.cursor ?? null);
    const page = pages[call];
    call += 1;
    if (!page) throw new Error("fetch called more times than pages provided");
    if (page.throw) throw new Error(page.throw);
    return {
      ok: page.ok !== false,
      status: page.status ?? 200,
      text: async () => page.text ?? "",
      json: async () => {
        if (page.jsonThrows) throw new Error(page.jsonThrows);
        return page.json;
      },
    };
  };
  return { impl, sentCursors, calls: () => call };
}

function orders(n, { amount = 1100, tax = 100 } = {}) {
  return Array.from({ length: n }, () => ({
    total_money: { amount },
    total_tax_money: { amount: tax },
  }));
}

const base = { accessToken: TOKEN, locationId: LOCATION, now: new Date("2026-08-24T05:00:00Z") };

test("multi_page_over_500_orders: 500 件超が欠損しない", async () => {
  const f = fakeFetch([
    { json: { orders: orders(500), cursor: "c1" } },
    { json: { orders: orders(500), cursor: "c2" } },
    { json: { orders: orders(37) } },
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "OK");
  assert.equal(r.order_count, 1037);
  assert.equal(r.pagination_pages, 3);
});

test("cursor_until_exhausted: cursor を次ページへ送り、尽きたら止まる", async () => {
  const f = fakeFetch([
    { json: { orders: orders(1), cursor: "c1" } },
    { json: { orders: orders(1), cursor: "c2" } },
    { json: { orders: orders(1) } },
  ]);
  await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.deepEqual(f.sentCursors, [null, "c1", "c2"]);
  assert.equal(f.calls(), 3);
});

test("api_error_fail_closed: API 失敗を 0 円にしない", async () => {
  const f = fakeFetch([{ ok: false, status: 401, text: "unauthorized" }]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "API_ERROR");
  assert.equal(r.error_state.http_status, 401);
  assert.equal(r.sales_tax_inclusive, null);
  assert.equal(r.sales_tax_exclusive, null);
  assert.equal(r.order_count, null);
  assert.notEqual(r.sales_tax_inclusive, 0);
});

test("pagination_error_fail_closed: 途中失敗で部分集計を返さない", async () => {
  const f = fakeFetch([
    { json: { orders: orders(500), cursor: "c1" } },
    { ok: false, status: 500, text: "boom" },
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "PAGINATION_ERROR");
  assert.equal(r.error_state.pages_completed, 1);
  assert.equal(r.sales_tax_inclusive, null, "1 ページ目の 550,000 円を実測値として返さない");
  assert.equal(r.order_count, null);
});

test("malformed_response_fail_closed: orders 非配列を空に丸めない", async () => {
  const f = fakeFetch([{ json: { orders: "nope" } }]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "MALFORMED_RESPONSE");
  assert.equal(r.sales_tax_inclusive, null);
});

test("JST_03_boundary: 02:59 JST は前営業日 / 03:00 JST は当日", () => {
  // 2026-08-24 02:59 JST = 2026-08-23 17:59 UTC
  assert.equal(businessDateJst(new Date("2026-08-23T17:59:00Z")), "2026-08-23");
  // 2026-08-24 03:00 JST = 2026-08-23 18:00 UTC
  assert.equal(businessDateJst(new Date("2026-08-23T18:00:00Z")), "2026-08-24");
});

test("JST boundary はサーバ TZ に依存しない", () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    assert.equal(businessDateJst(new Date("2026-08-23T18:00:00Z")), "2026-08-24");
    process.env.TZ = "UTC";
    assert.equal(businessDateJst(new Date("2026-08-23T18:00:00Z")), "2026-08-24");
  } finally {
    process.env.TZ = prev;
  }
});

test("MTD_period_boundary: 当月1日 03:00 JST 起点", () => {
  // 2026-08-24 14:00 JST
  assert.equal(mtdPeriodStart(new Date("2026-08-24T05:00:00Z")), "2026-08-01T03:00:00+09:00");
  // 2026-08-01 01:00 JST は営業日 7/31 -> MTD は 7 月起点
  assert.equal(mtdPeriodStart(new Date("2026-07-31T16:00:00Z")), "2026-07-01T03:00:00+09:00");
  // 2026-08-01 03:00 JST ちょうどは 8 月起点
  assert.equal(mtdPeriodStart(new Date("2026-07-31T18:00:00Z")), "2026-08-01T03:00:00+09:00");
});

test("tax_inclusive_exclusive_separation: 税込と税抜を別々に返す", async () => {
  const f = fakeFetch([{ json: { orders: orders(2, { amount: 1100, tax: 100 }) } }]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.sales_tax_inclusive, 2200, "実際に受け取った額（税込）");
  assert.equal(r.sales_tax_exclusive, 2000, "税抜売上");
  assert.notEqual(r.sales_tax_inclusive, r.sales_tax_exclusive);
  assert.equal("gross" in r, false, "gross という誤称 field を持たない");
});

test("legitimate_empty_period_returns_zero: 本当に 0 件なら 0 を返す", async () => {
  const f = fakeFetch([{ json: {} }]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "OK");
  assert.equal(r.order_count, 0);
  assert.equal(r.sales_tax_inclusive, 0);
  assert.equal(r.sales_tax_exclusive, 0);
});

test("config_missing は CONFIG_MISSING であって 0 円ではない", async () => {
  const f = fakeFetch([]);
  const r = await fetchMtd({ ...base, accessToken: undefined, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "CONFIG_MISSING");
  assert.equal(r.sales_tax_inclusive, null);
  assert.equal(f.calls(), 0, "認証情報が無いなら API を呼ばない");
});

/* --- money field fail-closed（欠損を 0 円に丸めない） --------------------- */

/** money 欠損の各形を、同じ主張（MALFORMED / 集計は null）で確かめる。 */
const MONEY_DEFECTS = [
  ["total_money ごと欠落", { total_tax_money: { amount: 100 } }],
  ["total_money.amount 欠落", { total_money: {}, total_tax_money: { amount: 100 } }],
  ["total_money.amount が文字列", { total_money: { amount: "1100" }, total_tax_money: { amount: 100 } }],
  ["total_money.amount が null", { total_money: { amount: null }, total_tax_money: { amount: 100 } }],
  ["total_money.amount が NaN", { total_money: { amount: NaN }, total_tax_money: { amount: 100 } }],
  ["total_tax_money ごと欠落", { total_money: { amount: 1100 } }],
  ["total_tax_money.amount 欠落", { total_money: { amount: 1100 }, total_tax_money: {} }],
  ["total_tax_money.amount が null", { total_money: { amount: 1100 }, total_tax_money: { amount: null } }],
  ["total_tax_money.amount が文字列", { total_money: { amount: 1100 }, total_tax_money: { amount: "100" } }],
  ["total_money が null", { total_money: null, total_tax_money: { amount: 100 } }],
];

for (const [label, order] of MONEY_DEFECTS) {
  test(`money_field_fail_closed: ${label} は MALFORMED_RESPONSE`, async () => {
    const f = fakeFetch([{ json: { orders: [order] } }]);
    const r = await fetchMtd({ ...base, fetchImpl: f.impl });
    assert.equal(r.error_state.state, "MALFORMED_RESPONSE");
    assert.equal(r.sales_tax_inclusive, null);
    assert.equal(r.sales_tax_exclusive, null);
    assert.equal(r.order_count, null);
    assert.notEqual(r.sales_tax_inclusive, 0, "欠損を 0 円として返さない");
  });
}

test("money_field_fail_closed: 1 件でも欠損すれば健全な同ページ分も集計しない", async () => {
  const f = fakeFetch([
    {
      json: {
        orders: [
          { total_money: { amount: 5000 }, total_tax_money: { amount: 500 } },
          { total_money: { amount: 7000 } }, // tax 欠落
          { total_money: { amount: 3000 }, total_tax_money: { amount: 300 } },
        ],
      },
    },
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "MALFORMED_RESPONSE");
  assert.equal(r.sales_tax_inclusive, null, "健全な 8,000 を実測値として返さない");
  assert.equal(r.order_count, null);
});

test("money_field_fail_closed: 欠損ページの検出でページ追跡を止める", async () => {
  const f = fakeFetch([
    { json: { orders: orders(1), cursor: "c1" } },
    { json: { orders: [{ total_money: { amount: 900 } }] } }, // tax 欠落
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "MALFORMED_RESPONSE");
  assert.equal(r.error_state.page, 2, "何ページ目で壊れたかを残す");
  assert.equal(f.calls(), 2, "壊れたページの先を取りにいかない");
  assert.equal(r.sales_tax_inclusive, null);
});

test("money_field_fail_closed: 金額 0 は欠損ではないので通る", async () => {
  const f = fakeFetch([
    { json: { orders: [{ total_money: { amount: 0 }, total_tax_money: { amount: 0 } }] } },
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "OK", "0 円の注文は正当なデータ");
  assert.equal(r.order_count, 1);
  assert.equal(r.sales_tax_inclusive, 0);
  assert.equal(r.sales_tax_exclusive, 0);
});

test("money_field_fail_closed: 非課税（tax 0）は明示されていれば通る", async () => {
  const f = fakeFetch([
    { json: { orders: [{ total_money: { amount: 1000 }, total_tax_money: { amount: 0 } }] } },
  ]);
  const r = await fetchMtd({ ...base, fetchImpl: f.impl });
  assert.equal(r.error_state.state, "OK");
  assert.equal(r.sales_tax_inclusive, 1000);
  assert.equal(r.sales_tax_exclusive, 1000, "税額 0 なら税込と税抜は一致する");
});

/* --- 返品コンテナの除外 ------------------------------------------------- */
