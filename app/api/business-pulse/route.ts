import { NextResponse } from "next/server";

import { composeBusinessPulse } from "@/lib/businessPulse";
import { fetchMtd, type SquareFetch } from "@/lib/squareMtd";

// 実測値を返す経路なので、フレームワークのキャッシュに載せない。
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 採択済み配達スナップショットと同一の 03:00 JST 営業日期間。 */
const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-24";

/**
 * Square に要求する窓。両端を固定する。
 * end を省くと fetchMtd は「取得時刻」で閉じるため、配達側の
 * 8/24 営業日終わり（= 8/25 03:00 JST）より広い期間を数えてしまう。
 */
const SQUARE_WINDOW = {
  start: "2026-08-01T03:00:00+09:00",
  end: "2026-08-25T03:00:00+09:00",
} as const;

/**
 * GET /api/business-pulse
 * Square 実測 + 採択済み配達スナップショットの READ_ONLY 合成。
 * 1 系統でも欠ければ合計を出さず state=INCOMPLETE を返す（0 円にしない）。
 */
export async function GET() {
  const square = await fetchMtd({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    locationId: process.env.SQUARE_LOCATION_ID ?? "",
    periodStart: SQUARE_WINDOW.start,
    periodEnd: SQUARE_WINDOW.end,
    fetchImpl: fetch as unknown as SquareFetch,
  });

  const pulse = composeBusinessPulse({
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    squareWindow: SQUARE_WINDOW,
    square,
  });

  // 合計が出せない状態を 200 で返さない。読めなかったことを HTTP でも伝える。
  const status =
    pulse.state === "INCOMPLETE"
      ? square.error_state.state === "CONFIG_MISSING"
        ? 503
        : 502
      : 200;

  return NextResponse.json(pulse, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}