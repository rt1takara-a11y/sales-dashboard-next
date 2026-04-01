import { NextResponse } from 'next/server';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID!;
const SQUARE_API = 'https://connect.squareup.com/v2/orders/search';
const DELIVERY_URL = 'https://sundubu-ai-context.vercel.app/data/delivery_orders.json';

function getBusinessDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (d.getHours() < 3) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDateRange(days: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

// Square注文 → records形式に変換
async function fetchSquareRecords() {
  const { start_at, end_at } = getDateRange(30);
  const res = await fetch(SQUARE_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-18',
    },
    body: JSON.stringify({
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          date_time_filter: { closed_at: { start_at, end_at } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'DESC' },
      },
      limit: 500,
    }),
  });
  if (!res.ok) return [];

  const json = await res.json();
  const rawOrders = json.orders || [];

  const grouped: Record<string, { date: string; platform: string; store: string; sales: number; fee: number; orders: number }> = {};
  rawOrders.forEach((o: any) => {
    const date = getBusinessDate(o.closed_at || o.created_at);
    const key = `${date}_square`;
    const gross = Math.round((o.total_money?.amount || 0) - (o.total_tax_money?.amount || 0));
    if (!grouped[key]) grouped[key] = { date, platform: 'square', store: 'nakameguro', sales: 0, fee: 0, orders: 0 };
    grouped[key].sales += gross;
    grouped[key].orders += 1;
  });

  return Object.values(grouped).map(r => ({ ...r, net: r.sales - r.fee, avg_7d: null, diff_prev: null }));
}

// デリバリーJSON（Uber/RocketNow） → records形式に変換
async function fetchDeliveryRecords() {
  const res = await fetch(DELIVERY_URL, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();

  // すでにrecords形式の場合
  if (Array.isArray(data.records)) return data.records;

  // 単日形式の場合：ordersをrecords形式に変換
  const orders = Array.isArray(data.orders) ? data.orders : [];
  if (orders.length === 0) return [];

  const grouped: Record<string, { date: string; platform: string; store: string; sales: number; fee: number; orders: number }> = {};
  orders.forEach((o: any) => {
    const date = data.date || new Date().toISOString().slice(0, 10);
    const platform = (o.platform || data.platform || 'delivery').toLowerCase();
    const key = `${date}_${platform}`;
    const gross = Number(o.gross || 0);
    const fee = Number(o.total_fees ?? o.fee ?? 0);
    if (!grouped[key]) grouped[key] = { date, platform, store: 'nakameguro', sales: 0, fee: 0, orders: 0 };
    grouped[key].sales += gross;
    grouped[key].fee += fee;
    grouped[key].orders += 1;
  });

  return Object.values(grouped).map(r => ({ ...r, net: r.sales - r.fee, avg_7d: null, diff_prev: null }));
}

export async function GET() {
  try {
    const [squareRecords, deliveryRecords] = await Promise.all([
      fetchSquareRecords(),
      fetchDeliveryRecords(),
    ]);

    // 全records を日付降順で結合
    const records = [...squareRecords, ...deliveryRecords]
      .sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({ records });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
