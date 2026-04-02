'use client';

import { useState, useEffect, useCallback } from 'react';

// const DATA_URL = 'https://sundubu-ai-context.vercel.app/data/delivery_orders.json';
const DATA_URL = '/api/all';

// ---------- ヘルパー ----------
function yen(v: number) {
  return '¥' + Number(v || 0).toLocaleString('ja-JP');
}
function pct(v: number) {
  return Math.round(Number(v || 0) * 1000) / 10 + '%';
}

// ---------- 型定義 ----------
interface DailyRecord {
  date: string;
  platform: string;
  store?: string;
  orders: number;
  sales: number;
  fee: number;
  net: number;
  avg_7d?: number;
  diff_prev?: number | null;
}
interface Order {
  item_name?: string;
  product_name?: string;
  qty?: number;
  gross?: number;
  fee?: number;
  total_fees?: number;
  status?: string;
  cancel_flag?: boolean;
  delay_flag?: boolean;
  _reconciled?: boolean;
  other_fee?: number;
  platform?: string;
}
interface Platform {
  platform: string;
  gross: number;
  fee: number;
  net: number;
  orders: number;
  items: number;
  cancelled: number;
  delayed: number;
  pending: number;
  fee_rate: number;
  cancel_rate: number;
  delay_rate: number;
  dependency: number;
}
interface Model {
  orders: Order[];
  gross: number;
  fee: number;
  net: number;
  orderCount: number;
  itemQty: number;
  feeRate: number;
  platforms: Platform[];
  alerts: { reconciled: number; cancelled: number; delayed: number; pending: number; fee_mismatch: number };
  topDependency: Platform | undefined;
  byDate: { [date: string]: DailyRecord[] };
}

// ---------- normalize ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalize(data: any): Model {
  const isWeekly = Array.isArray(data.records);
  const records: DailyRecord[] = isWeekly ? data.records : [];
  const orders: Order[] = isWeekly ? [] : Array.isArray(data.orders) ? data.orders : [];
  const k = data.kpi || {};

  const gross = isWeekly
    ? records.reduce((a, r) => a + Number(r.sales || 0), 0)
    : Number(k.gross_total ?? 0);
  const fee = isWeekly
    ? records.reduce((a, r) => a + Number(r.fee || 0), 0)
    : Number(k.fee_total ?? 0);
  const net = gross - fee;
  const orderCount = isWeekly
    ? records.reduce((a, r) => a + Number(r.orders || 0), 0)
    : Number(k.order_count ?? orders.length ?? 0);
  const itemQty = isWeekly ? 0 : Number(k.item_qty_total ?? orders.reduce((a, o) => a + Number(o.qty || 0), 0));
  const feeRate = gross ? fee / gross : 0;

  const grouped: { [p: string]: Platform } = {};

  if (isWeekly) {
    records.forEach(r => {
      const p = (r.platform || 'unknown').toLowerCase();
      if (!grouped[p]) grouped[p] = { platform: p, gross: 0, fee: 0, net: 0, orders: 0, items: 0, cancelled: 0, delayed: 0, pending: 0, fee_rate: 0, cancel_rate: 0, delay_rate: 0, dependency: 0 };
      grouped[p].gross += Number(r.sales || 0);
      grouped[p].fee += Number(r.fee || 0);
      grouped[p].net = grouped[p].gross - grouped[p].fee;
      grouped[p].orders += Number(r.orders || 0);
    });
  }

  const byDate: { [date: string]: DailyRecord[] } = {};
  if (isWeekly) {
    records.forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });
  }

  orders.forEach(o => {
    const p = (o.platform || data.platform || 'unknown').toLowerCase();
    if (!grouped[p]) grouped[p] = { platform: p, gross: 0, fee: 0, net: 0, orders: 0, items: 0, cancelled: 0, delayed: 0, pending: 0, fee_rate: 0, cancel_rate: 0, delay_rate: 0, dependency: 0 };
    grouped[p].gross += Number(o.gross || 0);
    grouped[p].fee += Number(o.total_fees ?? o.fee ?? 0);
    grouped[p].net += Number(o.gross || 0) - Number(o.total_fees ?? o.fee ?? 0);
    grouped[p].orders += 1;
    grouped[p].items += Number(o.qty || 0);
    if (o.cancel_flag || String(o.status || '').toLowerCase().includes('cancel')) grouped[p].cancelled += 1;
    if (o.delay_flag || String(o.status || '').toLowerCase().includes('delay')) grouped[p].delayed += 1;
    if (String(o.status || '').toLowerCase().includes('pending')) grouped[p].pending += 1;
  });

  const platforms: Platform[] = Object.values(grouped).map(p => ({
    ...p,
    fee_rate: p.gross ? p.fee / p.gross : 0,
    cancel_rate: p.orders ? p.cancelled / p.orders : 0,
    delay_rate: p.orders ? p.delayed / p.orders : 0,
    dependency: gross ? p.gross / gross : 0,
  }));

  const alerts = {
    reconciled: orders.filter(o => o._reconciled === true).length,
    cancelled: orders.filter(o => o.cancel_flag || String(o.status || '').toLowerCase().includes('cancel')).length,
    delayed: orders.filter(o => o.delay_flag || String(o.status || '').toLowerCase().includes('delay')).length,
    pending: orders.filter(o => String(o.status || '').toLowerCase().includes('pending')).length,
    fee_mismatch: orders.filter(o => Number(o.other_fee || 0) >= 2).length,
  };

  const topDependency = platforms.slice().sort((a, b) => b.dependency - a.dependency)[0];
  return { orders, gross, fee, net, orderCount, itemQty, feeRate, platforms, alerts, topDependency, byDate };
}

// ---------- DiffLabel ----------
function DiffLabel({ value }: { value: number | null }) {
  if (value === null) return null;
  if (value >= 0) return <span style={{ color: '#2a7a4b', fontSize: 12 }}> +{yen(value)}↑</span>;
  return <span style={{ color: '#c0392b', fontSize: 12 }}> {yen(value)}↓</span>;
}

// ---------- AlertBadge ----------
function AlertBadge({ record }: { record: DailyRecord }) {
  const badges: React.ReactNode[] = [];
  if (record.diff_prev !== null && record.diff_prev !== undefined) {
    if (record.diff_prev <= -0.20) {
      badges.push(
        <span key="drop" style={{ marginLeft: 6, background: '#fff0f0', color: '#c43d32', border: '1px solid #efc1bb', borderRadius: 6, padding: '2px 6px', fontSize: 11 }}>
          🔴 急落 {Math.round(record.diff_prev * 100)}%
        </span>
      );
    } else if (record.diff_prev >= 0.30) {
      badges.push(
        <span key="spike" style={{ marginLeft: 6, background: '#fffaf0', color: '#b6811d', border: '1px solid #ecd8a5', borderRadius: 6, padding: '2px 6px', fontSize: 11 }}>
          🟡 急上昇 +{Math.round(record.diff_prev * 100)}%
        </span>
      );
    }
  }
  if (record.avg_7d && record.sales < record.avg_7d * 0.80) {
    badges.push(
      <span key="below" style={{ marginLeft: 6, background: '#fff0f0', color: '#c43d32', border: '1px solid #efc1bb', borderRadius: 6, padding: '2px 6px', fontSize: 11 }}>
        🔴 平均比 {Math.round((record.sales / record.avg_7d - 1) * 100)}%
      </span>
    );
  }
  return <>{badges}</>;
}

// ---------- 期間フィルター ----------
type Period = '7' | '30' | 'month' | 'year';

function filterByPeriod(byDate: { [date: string]: DailyRecord[] }, period: Period) {
  const today = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);

  let start: string;
  if (period === '7') {
    const d = new Date(today); d.setDate(d.getDate() - 6); start = toStr(d);
  } else if (period === '30') {
    const d = new Date(today); d.setDate(d.getDate() - 29); start = toStr(d);
  } else if (period === 'month') {
    start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  } else {
    start = `${today.getFullYear()}-01-01`;
  }
  const end = toStr(today);
  return Object.fromEntries(
    Object.entries(byDate).filter(([date]) => date >= start && date <= end)
  );
}

function getPrevPeriodSales(byDate: { [date: string]: DailyRecord[] }, period: Period): number {
  const today = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);
  let start: string; let end: string;
  if (period === '7') {
    const e = new Date(today); e.setDate(e.getDate() - 7);
    const s = new Date(today); s.setDate(s.getDate() - 13);
    start = toStr(s); end = toStr(e);
  } else if (period === '30') {
    const e = new Date(today); e.setDate(e.getDate() - 30);
    const s = new Date(today); s.setDate(s.getDate() - 59);
    start = toStr(s); end = toStr(e);
  } else if (period === 'month') {
    const m = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
    const y = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
    start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    end = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  } else {
    start = `${today.getFullYear() - 1}-01-01`;
    end = `${today.getFullYear()}-01-01`;
  }
  return Object.entries(byDate)
    .filter(([date]) => date >= start && date < end)
    .flatMap(([, rows]) => rows)
    .reduce((a, r) => a + Number(r.sales || 0), 0);
}

// ---------- メインコンポーネント ----------
export default function Dashboard() {
  const [model, setModel] = useState<Model | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [period, setPeriod] = useState<Period>('7');
  const [updatedAt, setUpdatedAt] = useState('更新待ち');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    setUpdatedAt('更新中...');
    try {
      const res = await fetch(DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setModel(normalize(data));
      setUpdatedAt('更新: ' + new Date().toLocaleString('ja-JP'));
    } catch (e) {
      setError('読み込み失敗: ' + e);
      setUpdatedAt('更新失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const m = model;
  const dates = m ? Object.keys(m.byDate).sort().reverse() : [];

  // 期間フィルター済みデータ
  const filteredByDate = m ? filterByPeriod(m.byDate, period) : {};
  const filteredDates = Object.keys(filteredByDate).sort().reverse();
  const periodSales = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.sales || 0), 0);
  const periodFee = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.fee || 0), 0);
  const periodNet = periodSales - periodFee;
  const periodOrders = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.orders || 0), 0);
  const prevSales = m ? getPrevPeriodSales(m.byDate, period) : 0;
  const diffRatio = prevSales > 0 ? (periodSales - prevSales) / prevSales : null;

  // 日別売上（バーチャート用）
  const dailySales = filteredDates.map(date => ({
    date,
    sales: filteredByDate[date].reduce((a, r) => a + Number(r.sales || 0), 0),
  }));
  const maxSales = Math.max(...dailySales.map(d => d.sales), 1);

  // Platform内訳
  const platformSales: Record<string, number> = {};
  Object.values(filteredByDate).flat().forEach(r => {
    platformSales[r.platform] = (platformSales[r.platform] || 0) + Number(r.sales || 0);
  });
  const platformColors: Record<string, string> = { square: '#456fae', uber: '#4d8b63', rocketnow: '#b6811d', uber_eats: '#4d8b63' };

  const netPct = m && m.gross ? Math.max(0, (m.net / m.gross) * 100) : 0;
  const feePct = m && m.gross ? Math.max(0, (m.fee / m.gross) * 100) : 0;

  return (
    <div className="wrap">
      {/* ヘッダー */}
      <div className="header">
        <div className="titlebox">
          <h1>デリバリー売上ダッシュボード</h1>
          <div className="sub">実データ接続版 / delivery_orders.json 直結</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={loadData} disabled={loading}>更新</button>
          <button className="btn" onClick={() => window.open(DATA_URL, '_blank')}>生データを開く</button>
          <div className="sub">{updatedAt}</div>
        </div>
      </div>

      {/* タブ */}
      <div className="tabbar">
        {['overview', 'platforms', 'alerts'].map(tab => (
          <button key={tab} className={`tab${activeTab === tab ? ' active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'overview' ? 'Overview' : tab === 'platforms' ? 'Platforms' : 'Alerts'}
          </button>
        ))}
      </div>

      {/* 依存率バナー */}
      {m?.topDependency && m.topDependency.dependency > 0.45 && (
        <div className="banner">
          {m.topDependency.platform.toUpperCase()} 依存率 {pct(m.topDependency.dependency)}。45%超なので集中リスクあり。
        </div>
      )}

      {/* エラー */}
      {error && <div className="section" style={{ color: 'var(--danger)' }}>{error}</div>}

      {/* Overview タブ */}
      {activeTab === 'overview' && (
        <section>
          {/* 期間切替 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {([['7', '7日'], ['30', '30日'], ['month', '月'], ['year', '年']] as [Period, string][]).map(([p, label]) => (
              <button key={p} className={`tab${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>

          {/* 期間合計 */}
          <div className="grid">
            <div className="card">
              <div className="label">売上</div>
              <div className="value">{yen(periodSales)}</div>
              <div className="meta" style={{ marginTop: 6 }}>
                {diffRatio !== null && (
                  <span style={{ color: diffRatio >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                    {diffRatio >= 0 ? '↑' : '↓'} 前期間比 {Math.abs(Math.round(diffRatio * 100))}%
                  </span>
                )}
              </div>
            </div>
            <div className="card">
              <div className="label">手数料</div>
              <div className="value danger">{yen(periodFee)}</div>
              <div className="meta">fee_total</div>
            </div>
            <div className="card">
              <div className="label">利益</div>
              <div className="value ok">{yen(periodNet)}</div>
              <div className="meta">net_total</div>
            </div>
            <div className="card">
              <div className="label">注文数</div>
              <div className="value">{periodOrders.toLocaleString('ja-JP')}</div>
              <div className="meta">orders</div>
            </div>
          </div>

          {/* 日別推移バーチャート */}
          {dailySales.length > 0 && (
            <div className="section">
              <h2>日別推移</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dailySales.map(({ date, sales }) => (
                  <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ width: 90, color: 'var(--muted)', flexShrink: 0 }}>{date.slice(5)}</span>
                    <div style={{ flex: 1, background: '#e6e0d3', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.round((sales / maxSales) * 100)}%`, height: '100%', background: 'var(--ok)', borderRadius: 4 }} />
                    </div>
                    <span style={{ width: 80, textAlign: 'right', flexShrink: 0 }}>{yen(sales)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Platform内訳 */}
          {Object.keys(platformSales).length > 0 && (
            <div className="section">
              <h2>Platform内訳</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(platformSales).sort((a, b) => b[1] - a[1]).map(([plat, sales]) => {
                  const ratio = periodSales > 0 ? Math.round((sales / periodSales) * 100) : 0;
                  const color = platformColors[plat] || '#888';
                  return (
                    <div key={plat} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                      <span style={{ width: 90, color, fontWeight: 600, flexShrink: 0 }}>{plat.toUpperCase()}</span>
                      <div style={{ flex: 1, background: '#e6e0d3', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                        <div style={{ width: `${ratio}%`, height: '100%', background: color, borderRadius: 4 }} />
                      </div>
                      <span style={{ width: 80, textAlign: 'right', flexShrink: 0 }}>{ratio}%</span>
                    </div>
                  );
                })}
              </div>
              <div className="legend" style={{ marginTop: 12 }}>
                {Object.entries(platformSales).map(([plat]) => (
                  <span key={plat}>
                    <span className="dot" style={{ background: platformColors[plat] || '#888' }} />
                    {plat.toUpperCase()} {yen(platformSales[plat])}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 売上内訳バー */}
          <div className="section">
            <h2>売上内訳</h2>
            <div className="bar">
              <div style={{ background: 'var(--ok)', width: netPct + '%' }}>
                {netPct > 12 && m ? `利益 ${yen(m.net)}` : ''}
              </div>
              <div style={{ background: 'var(--danger)', width: feePct + '%' }}>
                {feePct > 12 && m ? `手数料 ${yen(m.fee)}` : ''}
              </div>
            </div>
            <div className="legend">
              <span><span className="dot" style={{ background: 'var(--ok)' }} />利益 {pct(netPct / 100)}</span>
              <span><span className="dot" style={{ background: 'var(--danger)' }} />手数料 {pct(feePct / 100)}</span>
            </div>
          </div>
        </section>
      )}

      {/* Platforms タブ */}
      {activeTab === 'platforms' && (
        <section>
          <div className="platform-grid">
            {m?.platforms.length === 0 && <div className="card">プラットフォームデータなし</div>}
            {m?.platforms.map(p => (
              <div key={p.platform} className="card">
                <div className="label">{p.platform.toUpperCase()}</div>
                <div className="mini-grid">
                  <div className="mini"><div className="label">売上</div><div className="value small">{yen(p.gross)}</div></div>
                  <div className="mini"><div className="label">利益</div><div className="value small ok">{yen(p.net)}</div></div>
                  <div className="mini"><div className="label">注文数</div><div className="value small">{p.orders}</div></div>
                </div>
                <div className="mini-grid">
                  <div className="mini"><div className="label">手数料率</div><div className={`value small${p.fee_rate > 0.33 ? ' danger' : ''}`}>{pct(p.fee_rate)}</div></div>
                  <div className="mini"><div className="label">cancel率</div><div className={`value small${p.cancel_rate > 0.1 ? ' danger' : ''}`}>{pct(p.cancel_rate)}</div></div>
                  <div className="mini"><div className="label">依存率</div><div className={`value small${p.dependency > 0.45 ? ' danger' : ''}`}>{pct(p.dependency)}</div></div>
                </div>
              </div>
            ))}
          </div>

          {/* 日別集計 */}
          {dates.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2 style={{ marginBottom: 12 }}>日別集計</h2>
              {dates.map((date, i) => {
                const rows = m!.byDate[date];
                const totalSales = rows.reduce((a, r) => a + Number(r.sales || 0), 0);
                const totalFee = rows.reduce((a, r) => a + Number(r.fee || 0), 0);
                const totalNet = totalSales - totalFee;
                const prevDate = dates[i + 1];
                const prevRows = prevDate ? m!.byDate[prevDate] : null;
                const prevSales = prevRows ? prevRows.reduce((a, r) => a + Number(r.sales || 0), 0) : null;
                const prevNet = prevRows ? prevRows.reduce((a, r) => a + (r.sales - r.fee), 0) : null;
                const diffSales = prevSales !== null ? totalSales - prevSales : null;
                const diffNet = prevNet !== null ? totalNet - prevNet : null;

                return (
                  <div key={date} className="section" style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>{date}</div>
                    {rows.map((r, j) => (
                      <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '4px 0', fontSize: 13, color: '#666', flexWrap: 'wrap' }}>
                        <span style={{ width: 100 }}>{r.platform.toUpperCase()}</span>
                        <span>売上 {yen(r.sales)}</span>
                        <span>手数料 {yen(r.fee)}</span>
                        <span>利益 {yen(r.sales - r.fee)}</span>
                        <AlertBadge record={r} />
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 16, padding: '6px 0 0', fontSize: 13, borderTop: '1px solid #eee', marginTop: 4 }}>
                      <span style={{ width: 100, fontWeight: 600 }}>合計</span>
                      <span>売上 {yen(totalSales)}<DiffLabel value={diffSales} /></span>
                      <span>手数料 {yen(totalFee)}</span>
                      <span>利益 {yen(totalNet)}<DiffLabel value={diffNet} /></span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Alerts タブ */}
      {activeTab === 'alerts' && m && (
        <section>
          <div className="alert-grid">
            {([
              ['reconciled', 'reconciled', m.alerts.reconciled],
              ['cancelled', 'cancelled', m.alerts.cancelled],
              ['delayed', 'delayed', m.alerts.delayed],
              ['pending', 'pending', m.alerts.pending],
              ['fee_mismatch', 'fee mismatch', m.alerts.fee_mismatch],
            ] as [string, string, number][]).map(([key, label, n]) => {
              const cls = n > 0 ? (key === 'cancelled' || key === 'fee_mismatch' ? 'danger' : 'warn') : '';
              return (
                <div key={key} className="alert-card">
                  <div className="label">{label}</div>
                  <div className={`n ${cls}`}>{n}</div>
                </div>
              );
            })}
          </div>
          <div className="section" style={{ marginTop: 14 }}>
            <h2>判定ルール</h2>
            <table>
              <tbody>
                <tr><th>fee_rate &gt; 33%</th><td>赤扱い</td></tr>
                <tr><th>cancel_rate &gt; 10%</th><td>赤扱い</td></tr>
                <tr><th>dependency &gt; 45%</th><td>依存警告</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
