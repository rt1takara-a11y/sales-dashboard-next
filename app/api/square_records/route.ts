import { NextResponse } from 'next/server';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const LOCATION_ID  = process.env.SQUARE_LOCATION_ID!;
const SQUARE_API   = 'https://connect.squareup.com/v2/orders/search';

function getBusinessDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (d.getHours() < 3) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 365); // 過去1年分
    start.setHours(0, 0, 0, 0);

    const res = await fetch(SQUARE_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        location_ids: [LOCATION_ID],
        query: {
          filter: {
            date_time_filter: { closed_at: { start_at: start.toISOString(), end_at: end.toISOString() } },
            state_filter:     { states: ['COMPLETED'] },
          },
          sort: { sort_field: 'CLOSED_AT', sort_order: 'DESC' },
        },
        limit: 500,
      }),
    });

    if (!res.ok) return NextResponse.json({ records: [] });

    const json      = await res.json();
    const rawOrders = json.orders || [];

    const grouped: Record<string, { date: string; platform: string; store: string; sales: number; fee: number; orders: number }> = {};
    rawOrders.forEach((o: any) => {
      const date  = getBusinessDate(o.closed_at || o.created_at);
      const key   = `${date}_square`;
      const gross = Math.round((o.total_money?.amount || 0) - (o.total_tax_money?.amount || 0));
      if (!grouped[key]) grouped[key] = { date, platform: 'square', store: 'nakameguro', sales: 0, fee: 0, orders: 0 };
      grouped[key].sales  += gross;
      grouped[key].orders += 1;
    });

    const records = Object.values(grouped)
      .map(r => ({ ...r, net: r.sales - r.fee, avg_7d: null, diff_prev: null }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({ records });
  } catch (e) {
    return NextResponse.json({ records: [], error: String(e) });
  }
}
