/**
 * Square LIVE MTD — 当月実測値の取得と集計（READ_ONLY / FAIL_CLOSED）。
 *
 * 設計上の不変条件:
 *  - 欠損を 0 円にしない。取得できなかったものは ERROR / UNKNOWN として返す
 *    （既存 route の `json.orders || []` は、不整合レスポンスを空配列に落として
 *      売上 0 に見せていた。ここではその経路を作らない）
 *  - cursor を尽きるまで追跡する。500 件で黙って打ち切らない
 *  - 税込 collected と税抜 sales を別 field で返す。片方を gross と呼ばない
 *  - 時刻はサーバ TZ に依存させない。JST 固定・営業日境界 03:00 JST
 */

export const JST_OFFSET_MINUTES = 9 * 60;
export const BUSINESS_DAY_START_HOUR = 3; // 03:00 JST

export type SquareFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export type MtdErrorState =
  | { state: "OK" }
  | { state: "API_ERROR"; detail: string; http_status?: number }
  | { state: "PAGINATION_ERROR"; detail: string; pages_completed: number }
  | { state: "MALFORMED_RESPONSE"; detail: string; page: number }
  | { state: "CONFIG_MISSING"; detail: string };

export interface MtdResult {
  source: "square";
  fetched_at: string;
  period_start: string;
  period_end: string;
  order_count: number | null;
  /** 顧客から実際に受け取った額（税込）。total_money の合計 */
  sales_tax_inclusive: number | null;
  /** 税抜売上。total_money - total_tax_money の合計 */
  sales_tax_exclusive: number | null;
  /**
   * 売上ではないと判定して集計から外した返品コンテナ注文の件数。
   * 0 を含め常に出す（除外を黙って行わないため）。
   */
  excluded_return_containers: number;
  pagination_pages: number;
  error_state: MtdErrorState;
}

/** JST の壁時計を「YYYY-MM-DDTHH:mm:ss+09:00」で組み立てる。 */
function jstIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:${p(second)}+09:00`;
}

/** 任意の時刻を JST の壁時計成分に分解する（サーバ TZ 非依存）。 */
export function toJstParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const shifted = new Date(at.getTime() + JST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * 営業日は 03:00 JST 始まり。00:00–02:59 JST は前日に属する。
 * 返り値は営業日の YYYY-MM-DD（JST）。
 */
export function businessDateJst(at: Date): string {
  const { year, month, day, hour } = toJstParts(at);
  const base = Date.UTC(year, month - 1, day);
  const shifted = hour < BUSINESS_DAY_START_HOUR ? base - 86_400_000 : base;
  const d = new Date(shifted);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * MTD の開始 = 「いま」が属する営業月の 1 日 03:00 JST。
 * 8/1 の 01:00 JST は営業日として 7/31 なので、MTD は 7 月起点になる。
 */
export function mtdPeriodStart(now: Date): string {
  const businessDate = businessDateJst(now); // YYYY-MM-DD
  const [year, month] = businessDate.split("-").map(Number);
  return jstIso(year, month, 1, BUSINESS_DAY_START_HOUR);
}

export function isoUtc(at: Date): string {
  return at.toISOString();
}

/**
 * 金額が両方そろって数値であることを検証済みの注文。
 * ここに入った時点で `?? 0` は不要になる（欠損は検証段階で弾かれている）。
 */
interface ValidatedOrder {
  total_amount: number;
  tax_amount: number;
}

const present = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * 返品コンテナ注文か。Square は返品を、元注文を参照する別注文として持つ。
 * 明細も決済も金額も持たず、returns / refunds / net_amounts だけを持つ形で、
 * これは売上ではない。
 *
 * 7 条件すべてに一致した時だけ真。1 つでも外れれば未知の形として
 * 金額検証へ落ち、MALFORMED_RESPONSE になる（除外の範囲を広げない）。
 */
function isReturnContainer(entry: Record<string, unknown>): boolean {
  return (
    !present(entry.total_money) &&
    !present(entry.total_tax_money) &&
    !present(entry.line_items) &&
    !present(entry.tenders) &&
    present(entry.returns) &&
    present(entry.refunds) &&
    present(entry.net_amounts)
  );
}

/**
 * money オブジェクトから amount を取り出す。欠落・非数値・非有限は
 * すべて MALFORMED_RESPONSE。0 に丸めない。
 */
function moneyAmount(
  container: unknown,
  field: string,
  page: number,
): { ok: true; amount: number } | { ok: false; error: MtdErrorState } {
  if (container === null || typeof container !== "object") {
    return {
      ok: false,
      error: { state: "MALFORMED_RESPONSE", detail: `${field} is missing`, page },
    };
  }
  const amount = (container as { amount?: unknown }).amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return {
      ok: false,
      error: {
        state: "MALFORMED_RESPONSE",
        detail: `${field}.amount is missing or not a finite number`,
        page,
      },
    };
  }
  return { ok: true, amount };
}

/** 1 ページ分のレスポンスを検証する。壊れていれば例外ではなく判定を返す。 */
function inspectPage(
  payload: unknown,
  page: number,
):
  | { ok: true; orders: ValidatedOrder[]; excluded: number; cursor?: string }
  | { ok: false; error: MtdErrorState } {
  if (payload === null || typeof payload !== "object") {
    return {
      ok: false,
      error: { state: "MALFORMED_RESPONSE", detail: "response is not an object", page },
    };
  }
  const body = payload as Record<string, unknown>;
  // orders 欠落は「0 件」ではなく不整合。空配列に丸めない。
  if (!("orders" in body)) {
    // Square は該当なしのとき orders を省く。cursor も無い場合のみ空とみなす。
    if ("cursor" in body) {
      return {
        ok: false,
        error: {
          state: "MALFORMED_RESPONSE",
          detail: "cursor present without orders",
          page,
        },
      };
    }
    return { ok: true, orders: [], excluded: 0 };
  }
  const orders = body.orders;
  if (!Array.isArray(orders)) {
    return {
      ok: false,
      error: { state: "MALFORMED_RESPONSE", detail: "orders is not an array", page },
    };
  }
  const validated: ValidatedOrder[] = [];
  let excluded = 0;
  for (const order of orders) {
    if (order === null || typeof order !== "object") {
      return {
        ok: false,
        error: { state: "MALFORMED_RESPONSE", detail: "order entry is not an object", page },
      };
    }
    const entry = order as Record<string, unknown>;
    // 返品は売上ではない。0 円の売上として数えることもしない。
    if (isReturnContainer(entry)) {
      excluded += 1;
      continue;
    }
    // 税込と税抜の両方を出す以上、どちらの金額が欠けても集計は成立しない。
    const total = moneyAmount(entry.total_money, "total_money", page);
    if (!total.ok) return { ok: false, error: total.error };
    const tax = moneyAmount(entry.total_tax_money, "total_tax_money", page);
    if (!tax.ok) return { ok: false, error: tax.error };
    validated.push({ total_amount: total.amount, tax_amount: tax.amount });
  }
  const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : undefined;
  return { ok: true, orders: validated, excluded, cursor };
}

export const SQUARE_SEARCH_URL = "https://connect.squareup.com/v2/orders/search";
const PAGE_LIMIT = 500;
const MAX_PAGES = 200; // 暴走防止。到達したら PAGINATION_ERROR（成功にしない）

export interface FetchMtdOptions {
  accessToken?: string;
  locationId: string;
  now?: Date;
  periodStart?: string;
  periodEnd?: string;
  fetchImpl: SquareFetch;
}

/**
 * 当月（MTD）の全注文を cursor が尽きるまで取得して集計する。
 * 失敗時は集計値を null にしたまま error_state を立てる（0 にしない）。
 */
export async function fetchMtd(options: FetchMtdOptions): Promise<MtdResult> {
  const now = options.now ?? new Date();
  const periodStart = options.periodStart ?? mtdPeriodStart(now);
  const periodEnd = options.periodEnd ?? isoUtc(now);
  const base: Omit<MtdResult, "error_state"> = {
    source: "square",
    fetched_at: isoUtc(now),
    period_start: periodStart,
    period_end: periodEnd,
    order_count: null,
    sales_tax_inclusive: null,
    sales_tax_exclusive: null,
    excluded_return_containers: 0,
    pagination_pages: 0,
  };

  if (!options.accessToken || !options.locationId) {
    return {
      ...base,
      error_state: {
        state: "CONFIG_MISSING",
        detail: "SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID is not configured",
      },
    };
  }

  let cursor: string | undefined;
  let pages = 0;
  let orderCount = 0;
  let inclusive = 0;
  let exclusive = 0;
  let excluded = 0;

  while (pages < MAX_PAGES) {
    const body: Record<string, unknown> = {
      location_ids: [options.locationId],
      query: {
        filter: {
          date_time_filter: { closed_at: { start_at: periodStart, end_at: periodEnd } },
          state_filter: { states: ["COMPLETED"] },
        },
        sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
      },
      limit: PAGE_LIMIT,
    };
    if (cursor) body.cursor = cursor;

    let response;
    try {
      response = await options.fetchImpl(SQUARE_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
          "Square-Version": "2024-01-18",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // 途中失敗。ここまでの部分集計は返さない（部分値を実測値と誤認させない）
      return {
        ...base,
        excluded_return_containers: excluded,
        pagination_pages: pages,
        error_state:
          pages === 0
            ? { state: "API_ERROR", detail: String(e) }
            : { state: "PAGINATION_ERROR", detail: String(e), pages_completed: pages },
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ...base,
        excluded_return_containers: excluded,
        pagination_pages: pages,
        error_state:
          pages === 0
            ? { state: "API_ERROR", detail, http_status: response.status }
            : { state: "PAGINATION_ERROR", detail, pages_completed: pages },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (e) {
      return {
        ...base,
        excluded_return_containers: excluded,
        pagination_pages: pages,
        error_state: { state: "MALFORMED_RESPONSE", detail: String(e), page: pages + 1 },
      };
    }

    const inspected = inspectPage(payload, pages + 1);
    if (!inspected.ok) {
      return {
        ...base,
        excluded_return_containers: excluded,
        pagination_pages: pages,
        error_state: inspected.error,
      };
    }

    excluded += inspected.excluded;
    // inspectPage を通った時点で両金額は数値。既定値へ丸める経路は持たない。
    for (const order of inspected.orders) {
      inclusive += order.total_amount;
      exclusive += order.total_amount - order.tax_amount;
      orderCount += 1;
    }
    pages += 1;
    cursor = inspected.cursor;
    if (!cursor) {
      return {
        ...base,
        order_count: orderCount,
        sales_tax_inclusive: inclusive,
        sales_tax_exclusive: exclusive,
        excluded_return_containers: excluded,
        pagination_pages: pages,
        error_state: { state: "OK" },
      };
    }
  }

  // cursor が尽きないまま上限。全件取得を主張できないので成功にしない。
  return {
    ...base,
    excluded_return_containers: excluded,
    pagination_pages: pages,
    error_state: {
      state: "PAGINATION_ERROR",
      detail: `cursor did not exhaust within ${MAX_PAGES} pages`,
      pages_completed: pages,
    },
  };
}