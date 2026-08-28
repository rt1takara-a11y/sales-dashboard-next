import { NextResponse } from "next/server";

import { fetchMtd, type SquareFetch } from "@/lib/squareMtd";

// 実測値を返す経路なので、フレームワークのキャッシュに載せない。
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/square/mtd
 * 当月（03:00 JST 始まり・当月1日起点）の Square 実測値を返す READ_ONLY 経路。
 * 失敗は 0 円ではなく error_state として返す（HTTP も 200 にしない）。
 */
export async function GET() {
  const result = await fetchMtd({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    locationId: process.env.SQUARE_LOCATION_ID ?? "",
    fetchImpl: fetch as unknown as SquareFetch,
  });

  const status =
    result.error_state.state === "OK"
      ? 200
      : result.error_state.state === "CONFIG_MISSING"
        ? 503
        : 502;

  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
