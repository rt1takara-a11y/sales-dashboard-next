import { NextResponse } from 'next/server';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID!;
const SQUARE_API   = 'https://connect.squareup.com/v2/orders/search';

function getBusinessDate(dateStr: string): string {
  // Square returns UTC → convert to JST (UTC+9) before date extraction
  const jst = new Date(new Date(dateStr).getTime() + 9 * 60 * 60 * 1000);
  if (jst.getUTCHours() < 3) jst.setUTCDate(jst.getUTCDate() - 1); // 深夜3時前は前日扱い
  return jst.toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const end   = new Date();
    const start = new Date('2026-01-01T00:00:00+09:00'); // 2026年1月1日 JST 固定

    const grouped: Record<string, { date: string; platform: string; store: string; sales: number; fee: number; orders: number }> = {};

    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const body: Record<string, unknown> = {
        location_ids: [LOCATION_ID],
        query: {
          filter: {
            date_time_filter: { closed_at: { start_at: start.toISOString(), end_at: end.toISOString() } },
            state_filter:     { states: ['COMPLETED'] },
          },
          sort: { sort_field: 'CLOSED_AT', sort_order: 'DESC' },
        },
        limit: 500,
      };
      if (cursor) body.cursor = cursor;

      const res = await fetch(SQUARE_API, {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${ACCESS_TOKEN}`,
          'Content-Type':   'application/json',
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) break;

      const json      = await res.json();
      const rawOrders = json.orders || [];
      cursor = json.cursor as string | undefined;
      pageCount++;

      rawOrders.forEach((o: Record<string, unknown>) => {
        const closed = (o.closed_at || o.created_at) as string;
        const date  = getBusinessDate(closed);
        const key   = `${date}_square`;
        const money = o.total_money as { amount?: number } | undefined;
        const tax   = o.total_tax_money as { amount?: number } | undefined;
        const gross = Math.round((money?.amount || 0) - (tax?.amount || 0));
        if (!grouped[key]) grouped[key] = { date, platform: 'square', store: 'nakameguro', sales: 0, fee: 0, orders: 0 };
        grouped[key].sales  += gross;
        grouped[key].orders += 1;
      });

      if (pageCount >= 20) break; // 安全上限（10,000件）
    } while (cursor);

    const records = Object.values(grouped)
      .map(r => ({ ...r, net: r.sales - r.fee, avg_7d: null, diff_prev: null }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({ records });
  } catch (e) {
    return NextResponse.json({ records: [], error: String(e) });
  }
}
