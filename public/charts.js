'use strict';
/* 零依赖 Canvas 图表：折线图 + 热力图 */
function cssVar(n) { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || '#94a3b8'; }

class LineChart {
  constructor(canvas, series) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = series; // [{key,label,color}]
  }
  draw(history) {
    const c = this.c, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || 300, H = c.clientHeight || 110;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const TXT = cssVar('--text'), MUTED = cssVar('--muted');
    const padL = 42, padR = 8, padT = 12, padB = 14;
    const iw = W - padL - padR, ih = H - padT - padB;
    if (!history || history.length < 2) {
      ctx.fillStyle = MUTED; ctx.font = '11px sans-serif';
      ctx.fillText('等待数据…', padL, H / 2);
      return;
    }
    const keys = this.series.map(s => s.key);
    let min = Infinity, max = -Infinity;
    for (const pt of history) for (const k of keys) {
      const v = pt[k]; if (typeof v !== 'number') continue;
      if (v < min) min = v; if (v > max) max = v;
    }
    if (min === Infinity) { min = 0; max = 1; }
    if (max - min < 1e-9) max = min + 1;
    const pad = (max - min) * 0.1;
    min = Math.max(0, min - pad); max = max + pad;
    // 网格 + Y 轴
    ctx.strokeStyle = 'rgba(148,163,184,.22)'; ctx.fillStyle = MUTED;
    ctx.font = '9px ui-monospace, monospace'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padT + ih * i / 3;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText((max - (max - min) * i / 3).toFixed(max < 10 ? 2 : 0), 2, y + 3);
    }
    const x0 = history[0].tick, x1 = history[history.length - 1].tick;
    const X = t => padL + (x1 === x0 ? iw / 2 : (t - x0) / (x1 - x0) * iw);
    const Y = v => padT + ih - (v - min) / (max - min) * ih;
    ctx.fillText(String(x0), padL, H - 3);
    const lx = String(x1); ctx.fillText(lx, W - padR - ctx.measureText(lx).width, H - 3);
    // 系列线
    for (const s of this.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false, lastX = 0, lastY = 0;
      for (const pt of history) {
        const v = pt[s.key]; if (typeof v !== 'number') continue;
        const x = X(pt.tick), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastX = x; lastY = y;
      }
      ctx.stroke();
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(lastX, lastY, 2.4, 0, 7); ctx.fill();
    }
    // 图例
    let px = padL; ctx.font = '10px sans-serif';
    for (const s of this.series) {
      ctx.fillStyle = s.color; ctx.fillRect(px, 2, 9, 3);
      ctx.fillStyle = TXT; ctx.fillText(s.label, px + 13, 8);
      px += ctx.measureText(s.label).width + 30;
    }
  }
}

// rows: 二维数组（每行一个机器，每列一个时段），值 0空闲 1运行 2超时 3已预约
function drawHeatmap(canvas, rows) {
  if (!canvas || !rows || !rows.length) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const cols = 48, cellH = 12;
  const H = rows.length * cellH + 2;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = W / cols;
  const colors = ['#141b2e', '#2dd4bf', '#fb7185', '#fbbf24'];
  rows.forEach((row, ri) => {
    for (let i = 0; i < cols; i++) {
      const v = row[row.length - cols + i];
      ctx.fillStyle = colors[v == null ? 0 : v] || colors[0];
      ctx.fillRect(i * cw + 0.5, ri * cellH + 1, Math.max(1, cw - 1), cellH - 2);
    }
  });
}

window.LineChart = LineChart;
window.drawHeatmap = drawHeatmap;
