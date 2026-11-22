'use strict';
// 群体层面统计指标
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) * (x - m))));
}

// 基尼系数（0=完全平均，1=一人独占）
function gini(values) {
  const arr = values.slice().sort((x, y) => x - y);
  const n = arr.length;
  if (!n) return 0;
  let sum = 0, cum = 0;
  for (let i = 0; i < n; i++) { sum += arr[i]; cum += (i + 1) * arr[i]; }
  if (sum <= 0) return 0;
  return Math.max(0, (2 * cum) / (n * sum) - (n + 1) / n);
}

// 前 frac 比例个体占据的份额（用于检测垄断）
function topShare(values, frac) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => b - a);
  const k = Math.max(1, Math.round(s.length * frac));
  const total = s.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return s.slice(0, k).reduce((a, b) => a + b, 0) / total;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : 0;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

module.exports = { mean, std, gini, topShare, percentile, pearson, clamp };
