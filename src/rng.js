'use strict';
// 可复现的伪随机数生成器：种子相同 → 序列相同，保证实验可重复
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.seed = (seed == null ? (Math.random() * 1e9) | 0 : seed) >>> 0;
    this._f = mulberry32(this.seed);
  }
  float() { return this._f(); }
  range(a, b) { return a + (b - a) * this._f(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); } // 闭区间
  pick(arr) { return arr[Math.floor(this._f() * arr.length)]; }
  chance(p) { return this._f() < p; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this._f() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}

module.exports = { Rng };
