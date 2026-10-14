import { useEffect, useState } from 'react';
import { BarChart3, X, Download } from 'lucide-react';
import { BACKEND_URL } from '../config';
import { formatPrice } from '../utils/format';

// Fecha local como 'AAAA-MM-DD' (la misma forma que espera /api/reports).
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const formatDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
};
const formatDateTime = (iso) => new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });

// Períodos rápidos, calculados en el momento (un panel abierto a medianoche no queda
// con "hoy" viejo).
const PRESETS = {
  today: { label: 'Hoy', range: () => { const t = new Date(); return [t, t]; } },
  week: { label: 'Últimos 7 días', range: () => { const t = new Date(); const f = new Date(t); f.setDate(t.getDate() - 6); return [f, t]; } },
  month: { label: 'Este mes', range: () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth(), 1), t]; } },
  lastMonth: {
    label: 'Mes anterior',
    range: () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]; }
  }
};

const inputStyle = {
  padding: '8px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.2)',
  border: '1px solid var(--border-color)', color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.85rem',
  colorScheme: 'dark'
};
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' };
const thStyle = { textAlign: 'left', color: 'var(--text-secondary)', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid var(--border-color)' };
const tdStyle = { padding: '6px 8px', borderBottom: '1px solid rgba(255, 255, 255, 0.04)' };
const numStyle = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// CSV con ";" (lo que Excel en español espera) y BOM para que respete las tildes.
const downloadCsv = (filename, header, rows) => {
  const escape = (v) => (/[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [header, ...rows].map(row => row.map(escape).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

// Ventas por día: una sola serie (sin leyenda; el título la nombra), barras finas con
// las puntas redondeadas y un tooltip por día. La tabla de abajo y el CSV dan los
// mismos números sin depender del gráfico.
function SalesByDayChart({ days }) {
  const [hovered, setHovered] = useState(null);
  const width = 640;
  const height = 180;
  const pad = { top: 16, right: 8, bottom: 22, left: 8 };
  const max = Math.max(...days.map(d => d.total), 0);
  const slot = (width - pad.left - pad.right) / days.length;
  const barWidth = Math.max(1, Math.min(28, slot - 2));
  const plotHeight = height - pad.top - pad.bottom;
  const labelIndexes = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Ventas por día">
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="var(--border-color)" />
        {max > 0 && (
          <text x={pad.left} y={pad.top - 4} fill="var(--text-muted)" fontSize="10">{formatPrice(max)}</text>
        )}
        {days.map((day, i) => {
          const x = pad.left + i * slot + (slot - barWidth) / 2;
          const h = max > 0 ? (day.total / max) * plotHeight : 0;
          const y = height - pad.bottom - h;
          const r = Math.min(4, barWidth / 2, h);
          return (
            <g key={day.date}>
              {h > 0 && (
                <path
                  d={`M${x},${height - pad.bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${height - pad.bottom} Z`}
                  fill="var(--accent-gold)"
                  opacity={hovered === null || hovered === i ? 1 : 0.45}
                />
              )}
              {/* Área de hover de toda la columna: más grande que la barra */}
              <rect
                x={pad.left + i * slot} y={pad.top} width={slot} height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
              {labelIndexes.has(i) && (
                <text x={pad.left + i * slot + slot / 2} y={height - 6} fill="var(--text-muted)" fontSize="10"
                  textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>
                  {formatDay(day.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered !== null && (
        <div
          role="tooltip"
          style={{
            position: 'absolute', top: 0, pointerEvents: 'none',
            left: `${((pad.left + (hovered + 0.5) * slot) / width) * 100}%`, transform: 'translateX(-50%)',
            background: 'var(--bg-dark)', border: '1px solid var(--border-color)', borderRadius: '8px',
            padding: '6px 10px', fontSize: '0.8rem', whiteSpace: 'nowrap'
          }}
        >
          <div style={{ color: 'var(--text-secondary)' }}>{formatDay(days[hovered].date)}</div>
          <div style={{ fontWeight: 700 }}>{formatPrice(days[hovered].total)}</div>
          <div style={{ color: 'var(--text-muted)' }}>{days[hovered].orders} {days[hovered].orders === 1 ? 'pedido' : 'pedidos'}</div>
        </div>
      )}
    </div>
  );
}

// Reportes de ventas del Mostrador: lo cobrado en un período, por día y por producto,
// más los cierres de caja. Los números salen de /api/reports (pedidos cobrados en la base).
export default function ReportsModal({ token, onClose }) {
  const [[from, to], setRange] = useState(() => PRESETS.week.range().map(dateKey));
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND_URL}/api/reports?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo cargar el reporte');
        return res.json();
      })
      .then(data => { if (!cancelled) { setReport(data); setError(''); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [from, to, token]);

  const applyPreset = (key) => setRange(PRESETS[key].range().map(dateKey));
  const activePreset = Object.keys(PRESETS).find(key => PRESETS[key].range().map(dateKey).join() === [from, to].join());

  const kpis = report && [
    ['Total vendido', formatPrice(report.total)],
    ['Mesas cobradas', report.visitsCount],
    ['Ticket promedio', formatPrice(report.averageTicket)],
    ['Pedidos', report.ordersCount],
    ['Cancelados', report.cancelledCount]
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '760px' }}>
        <div className="modal-header">
          <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BarChart3 size={22} style={{ color: 'var(--accent-gold)' }} /> Reportes de Ventas
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar reportes">
            <X size={24} />
          </button>
        </div>

        {/* Período: atajos y rango propio, en una sola fila */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '15px 0' }}>
          {Object.entries(PRESETS).map(([key, { label }]) => (
            <button
              key={key}
              className={`filter-btn ${activePreset === key ? 'active' : ''}`}
              onClick={() => applyPreset(key)}
            >
              {label}
            </button>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Desde
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setRange([e.target.value, to])} style={inputStyle} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Hasta
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setRange([from, e.target.value])} style={inputStyle} />
          </label>
        </div>

        {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}

        {report && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="report-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px' }}>
              {kpis.map(([label, value]) => (
                <div key={label} className="glass-panel" style={{ padding: '10px 14px' }}>
                  <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{value}</div>
                </div>
              ))}
            </div>

            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <h4 style={{ fontWeight: 700 }}>Ventas por día</h4>
                <button className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                  onClick={() => downloadCsv(`ventas-${from}-a-${to}.csv`, ['Fecha', 'Pedidos', 'Total'],
                    report.byDay.map(d => [d.date, d.orders, d.total]))}>
                  <Download size={12} /> Exportar CSV
                </button>
              </div>
              {report.total > 0
                ? <SalesByDayChart days={report.byDay} />
                : <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No hubo ventas cobradas en este período.</p>}
            </section>

            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <h4 style={{ fontWeight: 700 }}>Productos más vendidos</h4>
                {report.topProducts.length > 0 && (
                  <button className="btn-secondary" style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                    onClick={() => downloadCsv(`productos-${from}-a-${to}.csv`, ['Producto', 'Unidades', 'Total'],
                      report.topProducts.map(p => [p.name, p.quantity, p.total]))}>
                    <Download size={12} /> Exportar CSV
                  </button>
                )}
              </div>
              {report.topProducts.length > 0 ? (
                <table style={tableStyle} className="report-products">
                  <thead>
                    <tr><th style={thStyle}>Producto</th><th style={{ ...thStyle, textAlign: 'right' }}>Unidades</th><th style={{ ...thStyle, textAlign: 'right' }}>Total</th></tr>
                  </thead>
                  <tbody>
                    {report.topProducts.slice(0, 10).map(p => (
                      <tr key={p.productId}>
                        <td style={tdStyle}>{p.name}</td>
                        <td style={numStyle}>{p.quantity}</td>
                        <td style={numStyle}>{formatPrice(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Sin productos vendidos.</p>
              )}
            </section>

            <section>
              <h4 style={{ fontWeight: 700, marginBottom: '6px' }}>Cierres de caja</h4>
              {report.closures.length > 0 ? (
                <table style={tableStyle}>
                  <thead>
                    <tr><th style={thStyle}>Fecha</th><th style={{ ...thStyle, textAlign: 'right' }}>Pedidos</th><th style={{ ...thStyle, textAlign: 'right' }}>Total</th></tr>
                  </thead>
                  <tbody>
                    {[...report.closures].reverse().map(c => (
                      <tr key={c.closedAt}>
                        <td style={tdStyle}>{formatDateTime(c.closedAt)}</td>
                        <td style={numStyle}>{c.ordersCount}</td>
                        <td style={numStyle}>{formatPrice(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No hubo cierres de caja en este período.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
