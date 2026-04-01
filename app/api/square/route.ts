import { NextRequest, NextResponse } from 'next/server';

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID!;
const SQUARE_API = 'https://connect.squareup.com/v2/orders/search';

// 営業日判定：0:00〜2:59 は前日扱い
function getBusinessDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (d.getHours() < 3) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get('startDate') || getTodayStart();
  const endDate = searchParams.get('endDate') || getTodayEnd();

  try {
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
            date_time_filter: {
              closed_at: {
                start_at: startDate,
                end_at: endDate,
              },
            },
            state_filter: {
              states: ['COMPLETED'],
            },
          },
          sort: {
            sort_field: 'CLOSED_AT',
            sort_order: 'DESC',
          },
        },
        limit: 500,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const json = await res.json();
    const rawOrders = json.orders || [];

    // 注文を整形
    const orders = rawOrders.map((o: any) => {
      const gross = Math.round((o.total_money?.amount || 0) - (o.total_tax_money?.amount || 0));
      const businessDate = getBusinessDate(o.closed_at || o.created_at);
      return {
        id: o.id,
        date: businessDate,
        platform: 'square',
        item_name: o.line_items?.[0]?.name || '-',
        qty: o.line_items?.reduce((a: number, li: any) => a + Number(li.quantity || 0), 0) || 1,
        gross,
        fee: 0, // Square手数料は別途設定
        status: 'ok',
      };
    });

    // KPI集計
    const gross_total = orders.reduce((a: number, o: any) => a + o.gross, 0);
    const fee_total = 0;

    return NextResponse.json({
      platform: 'square',
      orders,
      kpi: {
        gross_total,
        fee_total,
        order_count: orders.length,
        item_qty_total: orders.reduce((a: number, o: any) => a + o.qty, 0),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function getTodayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function getTodayEnd() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
