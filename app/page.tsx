'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';

const SQUARE_URL = '/api/square_records';

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
interface UploadInfo {
  fileName: string;
  orders: number;
  dateMin: string;
  dateMax: string;
  platforms: string[];
  uploadedAt: string;
}

// ---------- platform 正規化 ----------
function normalizePlatform(raw: string): string {
  const s = (raw || '').trim().toLowerCase();
  if (s.includes('uber'))                              return 'uber';
  if (s.includes('rocket') || s === 'ロケット')        return 'rocketnow';
  if (s.includes('square') || s.includes('店'))        return 'square';
  return s || 'unknown';
}

// ---------- Uber Eats CSV → DailyRecord[] ----------
function parseUberEatsCSV(text: string): DailyRecord[] {
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = cleaned.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('データ行がありません');

  const headers   = lines[0].split(',').map(h => h.trim());
  const iStatus   = headers.findIndex(h => h.includes('注文状況'));
  const iAmount   = headers.findIndex(h => h.includes('注文単価'));
  const iDate     = headers.findIndex(h => h === '注文日');

  if (iStatus < 0 || iAmount < 0 || iDate < 0)
    throw new Error('Uber Eats CSVの列が見つかりません（注文状況・注文単価・注文日）');

  const grouped: Record<string, DailyRecord> = {};
  lines.slice(1).forEach(line => {
    const cols   = line.split(',').map(v => v.trim());
    if ((cols[iStatus] || '').toLowerCase() !== 'completed') return;
    const date   = (cols[iDate] || '').slice(0, 10);
    const amount = Math.round(Number((cols[iAmount] || '').replace(/[¥,]/g, '')) || 0);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) return;
    const key = `${date}__uber`;
    if (!grouped[key]) grouped[key] = { date, platform: 'uber', store: 'nakameguro', orders: 0, sales: 0, fee: 0, net: 0 };
    grouped[key].orders += 1;
    grouped[key].sales  += amount;
    grouped[key].net    += amount;
  });

  const result = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
  if (result.length === 0) throw new Error('completed ステータスの注文が見つかりませんでした');
  return result;
}

// ---------- CSV → DailyRecord[] ----------
function parseUploadCSV(text: string): DailyRecord[] {
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = cleaned.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('データ行がありません');

  const headers  = lines[0].split(',').map(h => h.trim().toLowerCase());
  const iDate    = headers.indexOf('date');
  const iSales   = headers.indexOf('sales');
  const iPlatform = headers.indexOf('platform');

  const missing = ['date', 'sales', 'platform'].filter(h => !headers.includes(h));
  if (missing.length > 0) throw new Error(`列が不足しています: ${missing.join(', ')}`);

  const grouped: Record<string, DailyRecord> = {};

  lines.slice(1).forEach(line => {
    const cols     = line.split(',').map(v => v.trim());
    const date     = (cols[iDate] || '').trim();
    const salesRaw = (cols[iSales] || '').replace(/[¥,]/g, '').trim();
    const platform = normalizePlatform(cols[iPlatform] || '');
    const sales    = Math.round(Number(salesRaw) || 0);

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || sales <= 0) return;

    const key = `${date}__${platform}`;
    if (!grouped[key]) {
      grouped[key] = { date, platform, store: 'nakameguro', orders: 0, sales: 0, fee: 0, net: 0 };
    }
    grouped[key].orders += 1;
    grouped[key].sales  += sales;
    grouped[key].net    += sales;
  });

  return Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- Excel → DailyRecord[] ----------
function parseExcel(buffer: ArrayBuffer): DailyRecord[] {
  const wb   = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

  // ヘッダー行を探す（3列以上あり、日付っぽい値がある行）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const row = rows[i] as string[];
    if (row.length >= 3 && row.some(c => typeof c === 'string' && c.length > 0)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('ヘッダー行が見つかりません');

  const headers = (rows[headerIdx] as string[]).map(h => String(h || '').trim().toLowerCase());

  // --- パターン①: 固定フォーマット (date / sales / platform) ---
  const iDate     = headers.indexOf('date');
  const iSales    = headers.indexOf('sales');
  const iPlatform = headers.indexOf('platform');
  const iItem     = headers.indexOf('item');

  if (iDate >= 0 && iSales >= 0 && iPlatform >= 0) {
    const grouped: Record<string, DailyRecord> = {};
    rows.slice(headerIdx + 1).forEach(row => {
      const r        = row as unknown[];
      const date     = String(r[iDate] || '').slice(0, 10);
      const sales    = Math.round(Number(String(r[iSales] || '').replace(/[¥,]/g, '')) || 0);
      const platform = normalizePlatform(String(r[iPlatform] || ''));
      void iItem; // item は集計に使わない
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || sales <= 0) return;
      const key = `${date}__${platform}`;
      if (!grouped[key]) grouped[key] = { date, platform, store: 'nakameguro', orders: 0, sales: 0, fee: 0, net: 0 };
      grouped[key].orders += 1;
      grouped[key].sales  += sales;
      grouped[key].net    += sales;
    });
    const result = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
    if (result.length > 0) return result;
  }

  // --- パターン②: Uber Eats Excel (注文状況 / 注文単価 / 注文日) ---
  const iStatus = headers.findIndex(h => h.includes('注文状況'));
  const iAmount = headers.findIndex(h => h.includes('注文単価'));
  const iUberDate = headers.findIndex(h => h === '注文日');
  if (iStatus >= 0 && iAmount >= 0 && iUberDate >= 0) {
    const grouped: Record<string, DailyRecord> = {};
    rows.slice(headerIdx + 1).forEach(row => {
      const r      = row as unknown[];
      if (String(r[iStatus] || '').toLowerCase() !== 'completed') return;
      const date   = String(r[iUberDate] || '').slice(0, 10);
      const amount = Math.round(Number(String(r[iAmount] || '').replace(/[¥,]/g, '')) || 0);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) return;
      const key = `${date}__uber`;
      if (!grouped[key]) grouped[key] = { date, platform: 'uber', store: 'nakameguro', orders: 0, sales: 0, fee: 0, net: 0 };
      grouped[key].orders += 1;
      grouped[key].sales  += amount;
      grouped[key].net    += amount;
    });
    const result = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
    if (result.length > 0) return result;
  }

  // --- パターン③: RocketNOW Excel (取引日 / 売上高 / 取引タイプ) ---
  const iRkDate  = headers.findIndex(h => h === '取引日');
  const iRkSales = headers.findIndex(h => h === '売上高');
  const iRkFee   = headers.findIndex(h => h === '総手数料');
  const iRkType  = headers.findIndex(h => h === '取引タイプ');
  if (iRkDate >= 0 && iRkSales >= 0 && iRkType >= 0) {
    const grouped: Record<string, DailyRecord> = {};
    rows.slice(headerIdx + 1).forEach(row => {
      const r = row as unknown[];
      if (String(r[iRkType] || '') !== 'PAY') return;
      const date  = String(r[iRkDate] || '').slice(0, 10);
      const sales = Math.round(Number(r[iRkSales] || 0));
      const fee   = iRkFee >= 0 ? Math.round(Number(r[iRkFee] || 0)) : 0;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || sales <= 0) return;
      const key = `${date}__rocketnow`;
      if (!grouped[key]) grouped[key] = { date, platform: 'rocketnow', store: 'nakameguro', orders: 0, sales: 0, fee: 0, net: 0 };
      grouped[key].orders += 1;
      grouped[key].sales  += sales;
      grouped[key].fee    += fee;
      grouped[key].net    += sales - fee;
    });
    const result = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
    if (result.length > 0) return result;
  }

  throw new Error('対応している列が見つかりません。date/sales/platform 列、またはUber Eats・RocketNOW形式のExcelを使用してください');
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
      grouped[p].fee   += Number(r.fee || 0);
      grouped[p].net    = grouped[p].gross - grouped[p].fee;
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
    grouped[p].gross  += Number(o.gross || 0);
    grouped[p].fee    += Number(o.total_fees ?? o.fee ?? 0);
    grouped[p].net    += Number(o.gross || 0) - Number(o.total_fees ?? o.fee ?? 0);
    grouped[p].orders += 1;
    grouped[p].items  += Number(o.qty || 0);
    if (o.cancel_flag || String(o.status || '').toLowerCase().includes('cancel')) grouped[p].cancelled += 1;
    if (o.delay_flag  || String(o.status || '').toLowerCase().includes('delay'))  grouped[p].delayed   += 1;
    if (String(o.status || '').toLowerCase().includes('pending')) grouped[p].pending += 1;
  });

  const platforms: Platform[] = Object.values(grouped).map(p => ({
    ...p,
    fee_rate:    p.gross  ? p.fee      / p.gross  : 0,
    cancel_rate: p.orders ? p.cancelled / p.orders : 0,
    delay_rate:  p.orders ? p.delayed   / p.orders : 0,
    dependency:  gross    ? p.gross    / gross     : 0,
  }));

  const alerts = {
    reconciled:  orders.filter(o => o._reconciled === true).length,
    cancelled:   orders.filter(o => o.cancel_flag || String(o.status || '').toLowerCase().includes('cancel')).length,
    delayed:     orders.filter(o => o.delay_flag  || String(o.status || '').toLowerCase().includes('delay')).length,
    pending:     orders.filter(o => String(o.status || '').toLowerCase().includes('pending')).length,
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
    end   = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  } else {
    start = `${today.getFullYear() - 1}-01-01`;
    end   = `${today.getFullYear()}-01-01`;
  }
  return Object.entries(byDate)
    .filter(([date]) => date >= start && date < end)
    .flatMap(([, rows]) => rows)
    .reduce((a, r) => a + Number(r.sales || 0), 0);
}

// ---------- メインコンポーネント ----------
export default function Dashboard() {
  const [model, setModel]           = useState<Model | null>(null);
  const [activeTab, setActiveTab]   = useState('overview');
  const [period, setPeriod]         = useState<Period>('7');
  const [updatedAt, setUpdatedAt]   = useState('更新待ち');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [uploadedRecords, setUploadedRecordsState] = useState<DailyRecord[]>([]);
  const [uploadInfo, setUploadInfoState]           = useState<UploadInfo | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [dragOver, setDragOver]       = useState(false);
  const uploadedRef = useRef<DailyRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // localStorage から復元
  useEffect(() => {
    try {
      const saved = localStorage.getItem('csv_records');
      const info  = localStorage.getItem('csv_upload_info');
      if (saved) {
        const records = JSON.parse(saved) as DailyRecord[];
        uploadedRef.current = records;
        setUploadedRecordsState(records);
      }
      if (info) setUploadInfoState(JSON.parse(info));
    } catch { /* ignore */ }
  }, []);

  function setUploadedRecords(records: DailyRecord[]) {
    uploadedRef.current = records;
    setUploadedRecordsState(records);
  }

  // Square API から取得 → CSV データとマージ
  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    setUpdatedAt('更新中...');
    try {
      const res = await fetch(SQUARE_URL, { cache: 'no-store' });
      const squareRecords: DailyRecord[] = res.ok
        ? ((await res.json()).records || [])
        : [];

      const uploaded    = uploadedRef.current;
      const uploadedKeys = new Set(uploaded.map(r => `${r.date}__${r.platform}`));

      // アップロード済みデータを優先、Square は補完
      const merged = [
        ...uploaded,
        ...squareRecords.filter(r => !uploadedKeys.has(`${r.date}__${r.platform}`)),
      ].sort((a, b) => b.date.localeCompare(a.date));

      setModel(normalize({ records: merged }));
      setUpdatedAt('更新: ' + new Date().toLocaleString('ja-JP'));
    } catch (e) {
      setError('読み込み失敗: ' + e);
      setUpdatedAt('更新失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // アップロード完了処理（既存データとマージ）
  function finishUpload(newRecords: DailyRecord[], fileName: string) {
    if (newRecords.length === 0) throw new Error('有効な注文データが見つかりませんでした');

    // 同じ date+platform は新データで上書き、それ以外は既存を保持
    const newKeys  = new Set(newRecords.map(r => `${r.date}__${r.platform}`));
    const merged   = [
      ...uploadedRef.current.filter(r => !newKeys.has(`${r.date}__${r.platform}`)),
      ...newRecords,
    ].sort((a, b) => b.date.localeCompare(a.date));

    const dates     = merged.map(r => r.date).sort();
    const platforms = [...new Set(merged.map(r => r.platform))];
    const info: UploadInfo = {
      fileName,
      orders:     merged.reduce((s, r) => s + r.orders, 0),
      dateMin:    dates[0],
      dateMax:    dates[dates.length - 1],
      platforms,
      uploadedAt: new Date().toLocaleString('ja-JP'),
    };

    setUploadedRecords(merged);
    setUploadInfoState(info);
    localStorage.setItem('csv_records',     JSON.stringify(merged));
    localStorage.setItem('csv_upload_info', JSON.stringify(info));
    loadData();
  }

  function processFile(file: File) {
    setUploadError('');
    const ext    = file.name.split('.').pop()?.toLowerCase();
    const reader = new FileReader();

    if (ext === 'xlsx' || ext === 'xls') {
      reader.onload = ev => {
        try {
          const records = parseExcel(ev.target!.result as ArrayBuffer);
          if (records.length === 0) throw new Error('有効な注文データが見つかりませんでした');
          finishUpload(records, file.name);
        } catch (e) {
          setUploadError('エラー: ' + (e instanceof Error ? e.message : String(e)));
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = ev => {
        try {
          const text      = ev.target!.result as string;
          const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
          const isUber    = firstLine.includes('注文状況') || firstLine.includes('注文単価');
          const records   = isUber ? parseUberEatsCSV(text) : parseUploadCSV(text);
          if (records.length === 0) throw new Error('有効な注文データが見つかりませんでした');
          finishUpload(records, file.name);
        } catch (e) {
          setUploadError('エラー: ' + (e instanceof Error ? e.message : String(e)));
        }
      };
      reader.readAsText(file, 'utf-8');
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext || '')) {
      setUploadError('CSV または Excel ファイルをドロップしてください');
      return;
    }
    processFile(file);
  }

  function clearUpload() {
    setUploadedRecords([]);
    setUploadInfoState(null);
    localStorage.removeItem('csv_records');
    localStorage.removeItem('csv_upload_info');
    loadData();
  }

  const m = model;

  // 期間フィルター済みデータ
  const filteredByDate  = m ? filterByPeriod(m.byDate, period) : {};
  const filteredDates   = Object.keys(filteredByDate).sort().reverse();
  const periodSales     = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.sales || 0), 0);
  const periodFee       = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.fee || 0), 0);
  const periodNet       = periodSales - periodFee;
  const periodOrders    = Object.values(filteredByDate).flat().reduce((a, r) => a + Number(r.orders || 0), 0);
  const prevSales       = m ? getPrevPeriodSales(m.byDate, period) : 0;
  const diffRatio       = prevSales > 0 ? (periodSales - prevSales) / prevSales : null;

  const platformColors: Record<string, string> = { square: '#456fae', uber: '#4d8b63', rocketnow: '#b6811d', uber_eats: '#4d8b63' };

  const dailySales = filteredDates.map(date => ({
    date,
    rows: filteredByDate[date],
    total: filteredByDate[date].reduce((a, r) => a + Number(r.sales || 0), 0),
  }));
  const maxSales = Math.max(...dailySales.map(d => d.total), 1);

  const platformSales: Record<string, number> = {};
  Object.values(filteredByDate).flat().forEach(r => {
    platformSales[r.platform] = (platformSales[r.platform] || 0) + Number(r.sales || 0);
  });

  // 期間フィルター済みプラットフォーム集計
  const filteredPlatformMap: Record<string, { platform: string; gross: number; fee: number; net: number; orders: number; fee_rate: number; dependency: number }> = {};
  Object.values(filteredByDate).flat().forEach(r => {
    const p = r.platform;
    if (!filteredPlatformMap[p]) filteredPlatformMap[p] = { platform: p, gross: 0, fee: 0, net: 0, orders: 0, fee_rate: 0, dependency: 0 };
    filteredPlatformMap[p].gross  += Number(r.sales || 0);
    filteredPlatformMap[p].fee    += Number(r.fee   || 0);
    filteredPlatformMap[p].net    += Number(r.sales || 0) - Number(r.fee || 0);
    filteredPlatformMap[p].orders += Number(r.orders || 0);
  });
  const filteredPlatforms = Object.values(filteredPlatformMap).map(p => ({
    ...p,
    fee_rate:   p.gross ? p.fee / p.gross : 0,
    dependency: periodSales ? p.gross / periodSales : 0,
  }));

  const netPct = periodSales ? Math.max(0, (periodNet / periodSales) * 100) : 0;
  const feePct = periodSales ? Math.max(0, (periodFee / periodSales) * 100) : 0;

  const TABS = [
    { id: 'overview',  label: 'Overview'  },
    { id: 'platforms', label: 'Platforms' },
    { id: 'alerts',    label: 'Alerts'    },
    { id: 'upload',    label: `アップロード${uploadedRecords.length > 0 ? ' ●' : ''}` },
  ];

  return (
    <div className="wrap">
      {/* ヘッダー */}
      <div className="header">
        <div className="titlebox">
          <h1>デリバリー売上ダッシュボード</h1>
          <div className="sub">Square 自動取得 + CSV アップロード対応</div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={loadData} disabled={loading}>更新</button>
          <div className="sub">{updatedAt}</div>
        </div>
      </div>

      {/* タブ */}
      <div className="tabbar">
        {TABS.map(tab => (
          <button key={tab.id} className={`tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
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

      {/* ===== Overview ===== */}
      {activeTab === 'overview' && (
        <section>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {([['7', '7日'], ['30', '30日'], ['month', '月'], ['year', '年']] as [Period, string][]).map(([p, label]) => (
              <button key={p} className={`tab${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>

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

          {dailySales.length > 0 && (
            <div className="section">
              <h2>日別推移</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dailySales.map(({ date, rows, total }) => (
                  <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <span style={{ width: 90, color: 'var(--muted)', flexShrink: 0 }}>{date.slice(5)}</span>
                    <div style={{ flex: 1, background: '#e6e0d3', borderRadius: 4, height: 18, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', width: `${Math.round((total / maxSales) * 100)}%`, height: '100%' }}>
                        {rows.sort((a, b) => b.sales - a.sales).map((r, i) => (
                          <div key={i} style={{ flex: r.sales, background: platformColors[r.platform] || '#888' }} />
                        ))}
                      </div>
                    </div>
                    <span style={{ width: 80, textAlign: 'right', flexShrink: 0 }}>{yen(total)}</span>
                  </div>
                ))}
              </div>
              <div className="legend" style={{ marginTop: 8 }}>
                {Object.keys(platformSales).map(plat => (
                  <span key={plat}><span className="dot" style={{ background: platformColors[plat] || '#888' }} />{plat.toUpperCase()}</span>
                ))}
              </div>
            </div>
          )}

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

          <div className="section">
            <h2>売上内訳</h2>
            <div className="bar">
              <div style={{ background: 'var(--ok)', width: netPct + '%' }}>
                {netPct > 12 ? `利益 ${yen(periodNet)}` : ''}
              </div>
              <div style={{ background: 'var(--danger)', width: feePct + '%' }}>
                {feePct > 12 ? `手数料 ${yen(periodFee)}` : ''}
              </div>
            </div>
            <div className="legend">
              <span><span className="dot" style={{ background: 'var(--ok)' }} />利益 {yen(periodNet)} ({pct(netPct / 100)})</span>
              <span><span className="dot" style={{ background: 'var(--danger)' }} />手数料 {yen(periodFee)} ({pct(feePct / 100)})</span>
            </div>
          </div>
        </section>
      )}

      {/* ===== Platforms ===== */}
      {activeTab === 'platforms' && (
        <section>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {([['7', '7日'], ['30', '30日'], ['month', '月'], ['year', '年']] as [Period, string][]).map(([p, label]) => (
              <button key={p} className={`tab${period === p ? ' active' : ''}`} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>

          <div className="platform-grid">
            {filteredPlatforms.length === 0 && <div className="card">プラットフォームデータなし</div>}
            {filteredPlatforms.sort((a, b) => b.gross - a.gross).map(p => (
              <div key={p.platform} className="card">
                <div className="label">{p.platform.toUpperCase()}</div>
                <div className="mini-grid">
                  <div className="mini"><div className="label">売上</div><div className="value small">{yen(p.gross)}</div></div>
                  <div className="mini"><div className="label">利益</div><div className="value small ok">{yen(p.net)}</div></div>
                  <div className="mini"><div className="label">注文数</div><div className="value small">{p.orders}</div></div>
                </div>
                <div className="mini-grid">
                  <div className="mini"><div className="label">手数料率</div><div className={`value small${p.fee_rate > 0.33 ? ' danger' : ''}`}>{pct(p.fee_rate)}</div></div>
                  <div className="mini"><div className="label">手数料</div><div className="value small danger">{yen(p.fee)}</div></div>
                  <div className="mini"><div className="label">依存率</div><div className={`value small${p.dependency > 0.45 ? ' danger' : ''}`}>{pct(p.dependency)}</div></div>
                </div>
              </div>
            ))}
          </div>

          {filteredDates.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2 style={{ marginBottom: 12 }}>日別集計</h2>
              {filteredDates.map((date, i) => {
                const rows       = filteredByDate[date];
                const totalSales = rows.reduce((a, r) => a + Number(r.sales || 0), 0);
                const totalFee   = rows.reduce((a, r) => a + Number(r.fee || 0), 0);
                const totalNet   = totalSales - totalFee;
                const prevDate   = filteredDates[i + 1];
                const prevRows   = prevDate ? filteredByDate[prevDate] : null;
                const prevSalesD = prevRows ? prevRows.reduce((a, r) => a + Number(r.sales || 0), 0) : null;
                const prevNetD   = prevRows ? prevRows.reduce((a, r) => a + (r.sales - r.fee), 0) : null;
                const diffSales  = prevSalesD !== null ? totalSales - prevSalesD : null;
                const diffNet    = prevNetD   !== null ? totalNet   - prevNetD   : null;

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

      {/* ===== Alerts ===== */}
      {activeTab === 'alerts' && m && (
        <section>
          <div className="alert-grid">
            {([
              ['reconciled',  'reconciled',  m.alerts.reconciled],
              ['cancelled',   'cancelled',   m.alerts.cancelled],
              ['delayed',     'delayed',     m.alerts.delayed],
              ['pending',     'pending',     m.alerts.pending],
              ['fee_mismatch','fee mismatch',m.alerts.fee_mismatch],
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

      {/* ===== アップロード ===== */}
      {activeTab === 'upload' && (
        <section>
          {/* ドロップゾーン */}
          <div
            className="section"
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? 'var(--ok)' : '#ccc'}`,
              borderRadius: 10,
              padding: '32px 24px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#f0faf4' : '#fafaf8',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>ファイルをドロップ、またはクリックして選択</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>CSV・Excel (.xlsx) 対応</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>

          {uploadError && (
            <div style={{ color: 'var(--danger)', marginTop: 12, padding: '10px 14px', background: '#fff0f0', borderRadius: 8, fontSize: 13 }}>
              {uploadError}
            </div>
          )}

          {/* 現在のアップロード状態 */}
          {uploadInfo && (
            <div className="section" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>アップロード済みデータ</h2>
                <button className="btn" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={clearUpload}>
                  クリア
                </button>
              </div>
              <table>
                <tbody>
                  <tr><th>ファイル</th><td>{uploadInfo.fileName}</td></tr>
                  <tr><th>期間</th><td>{uploadInfo.dateMin} 〜 {uploadInfo.dateMax}</td></tr>
                  <tr><th>注文数</th><td>{uploadInfo.orders.toLocaleString('ja-JP')} 件</td></tr>
                  <tr><th>媒体</th><td>{uploadInfo.platforms.map(p => p.toUpperCase()).join(', ')}</td></tr>
                  <tr><th>アップロード日時</th><td>{uploadInfo.uploadedAt}</td></tr>
                </tbody>
              </table>
            </div>
          )}

          {/* フォーマット説明 */}
          <div className="section" style={{ marginTop: 16 }}>
            <h2>CSVフォーマット</h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
              1行＝1注文（または1会計）。ヘッダー行必須。
            </div>
            <pre style={{ background: '#f5f3ef', padding: '12px 16px', borderRadius: 8, fontSize: 12, overflowX: 'auto', lineHeight: 1.7 }}>
{`date,sales,platform,item
2026-04-15,2330,uber,海鮮ドゥブ
2026-04-15,1780,uber,豚キムチドゥブ
2026-04-15,3200,square,海老ドゥブ
2026-04-15,2860,rocket,NEW海老ドゥブ
2026-04-15,1500,店内,スンドゥブ`}
            </pre>
            <table style={{ marginTop: 12 }}>
              <tbody>
                <tr><th>date</th><td>日付（YYYY-MM-DD）</td></tr>
                <tr><th>sales</th><td>注文金額（税込・円）</td></tr>
                <tr><th>platform</th><td>uber / rocket / square / 店内 など自由記述</td></tr>
                <tr><th>item</th><td>商品名またはカテゴリ（集計には使わない）</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
