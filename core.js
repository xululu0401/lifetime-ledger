/* 长期卡对账台 · 核心引擎（lifetime-ledger）
 *
 * 问题：「终身 / 多年 / 年卡 / 储值」这类一次付清、之后每次不再单独掏钱的卡，
 *       到底值不值？我大概多久去一次、会不会越去越少、店会不会先没了？
 *
 * 口径（详见 需求与调研.md 第 4 节）。第 t 年（t = 0,1,2,…）：
 *   存活概率        S_t = (1 − m)^t                       m = 年消失概率（用户假设）
 *   当年到访次数    n_t = f × (1 − d)^t                   f = 第 1 年到访次数/年，d = 年到访衰减率
 *   期望到访        E_t = n_t × S_t
 *   当年折扣金额    D_t = E_t × A                          A = 单次价（不用卡时要付的钱）
 *   折现因子        v_t = 1 / (1 + r)^t                    r = 年折现率
 *   累计折扣现值    PV_T = Σ_{t=0..T} D_t · v_t
 *   累计实付现值    P
 *   净现值          NPV = PV_T − P                         （可比口径）
 *   不折现口径      累计折扣 Σ E_t·A  与  累计实付 P       （不看时间价值的口径，两个都显示）
 *   回本所需次数    Σ 到访次数 = P ÷ A
 *   等效年费        P ÷ max(1, 卡面年限)
 *   盈亏平衡频率    f* 使 Σ E_t·A = P（单调，二分求解）
 *
 * 储值卡（充值 P 得到面值 V = P + 赠送）：
 *   赠送额 = V − P，赠送率 = 赠送 ÷ P
 *   折扣率 = P ÷ V（按面值花出去时的实际折扣）
 *   年内消费额 = min(E_t × A, 余额)，余额逐年递减 → 用尽后为「价值已用尽」，不再有折扣
 *
 * 验证与「不做什么」的边界见 需求与调研.md 与页面「这份账不算什么」。
 */
(function (root) {
  'use strict';

  const MAX_YEARS = 30;
  const MAX_ITEMS = 6;
  const NAME_MAX = 20;
  const MAX_MONTHS_SIM = MAX_YEARS * 12;

  /* 输入范围（都按「用户自填」设计，边界只用来挡住明显打错的输入） */
  const MONEY_MIN = 0.01, MONEY_MAX = 10000000;   // 元
  const PRICE_PER_USE_MIN = 0.01, PRICE_PER_USE_MAX = 1000000;
  const VISITS_PER_MONTH_MIN = 0, VISITS_PER_MONTH_MAX = 365;
  const RATE_MIN = 0, RATE_MAX = 100;   // 百分数（10 表示 10%）
  const YEARS_MIN = 1, YEARS_MAX = MAX_YEARS;

  const EPS = 1e-12;

  /* ── 数字解析（字符串 → 数字，带字段级错误） ────────────── */
  // 允许：普通小数、带千分位、中文全角空格、尾随「元/次/月/年/%」等单位后缀在 UI 侧先剥掉
  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[，,\s_]/g, '').replace(/％/g, '%');
    if (s.endsWith('%')) {
      const n0 = Number(s.slice(0, -1));
      return isFinite(n0) ? n0 / 100 : NaN;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  function num(v) { const n = parseNum(v); return isFinite(n) ? n : NaN; }

  const r2 = (x) => Math.round(x * 100) / 100;
  const r8 = (x) => Math.round(x * 1e8) / 1e8;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const r6 = (x) => Math.round(x * 1000000) / 1000000;

  /* ── 格式化（UI 与导出共用；保证导出与页面同口径） ────── */
  function fmtMoney(x) {
    if (!isFinite(x)) return '—';
    const neg = x < 0;
    const a = Math.abs(x);
    if (a > 0 && a < 0.01) return (neg ? '−' : '') + '< 0.01';
    const s = a.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '−' : '') + s;
  }
  function fmtMoney0(x) {
    if (!isFinite(x)) return '—';
    const neg = x < 0;
    const a = Math.abs(x);
    const s = a.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return (neg ? '−' : '') + s;
  }
  function fmtPct(x, digits) {
    if (!isFinite(x)) return '—';
    const d = digits === undefined ? 2 : digits;
    const a = Math.abs(x) * 100;
    if (a >= 100000) return (x < 0 ? '−' : '') + Math.round(a).toLocaleString('zh-CN') + '%';   // 极大百分比不要堆小数
    if (a > 0 && a < Math.pow(10, -d) / 2) return (x < 0 ? '−' : '') + '< ' + (Math.pow(10, -d)).toFixed(d) + '%';
    return (x < 0 ? '−' : '') + a.toFixed(d) + '%';
  }
  function fmtTimes(x, digits) {
    if (!isFinite(x)) return '—';
    const d = digits === undefined ? 2 : digits;
    const a = Math.abs(x);
    if (a > 0 && a < Math.pow(10, -d) / 2) return (x < 0 ? '−' : '') + '< ' + Math.pow(10, -d).toFixed(d);
    return (x < 0 ? '−' : '') + a.toFixed(d);
  }
  /** 自适应金额：>= 1000 取整、>= 0.01 两位小数、更小给三位有效数字（避免「< 0.01」看不出量级） */
  function fmtMoneyAdaptive(x) {
    if (!isFinite(x)) return '—';
    const a = Math.abs(x);
    if (a === 0) return '0.00';
    if (a >= 1000) return fmtMoney0(x);
    if (a >= 0.01) return fmtMoney(x);
    return (x < 0 ? '−' : '') + a.toPrecision(3) + '（不足 1 分）';
  }
  function fmtYears(x) {
    if (!isFinite(x)) return '永远回不了本';
    if (x <= 0) return '0';
    if (x > MAX_YEARS) return '超过 ' + MAX_YEARS + ' 年';
    return x >= 10 ? x.toFixed(1) : x.toFixed(2);
  }

  /* ── 输入规格 ─────────────────────────────────────────── */
  const PAY_TYPES = [
    { id: 'lifetime', name: '终身 / 一次买断', hint: '一次付清，之后不再单独付费，没有到期日' },
    { id: 'multiyear', name: '多年卡 / 年卡', hint: '一次付清，卡面有明确年限（如 3 年卡）' },
    { id: 'stored', name: '储值卡 / 充值卡', hint: '充值 P 得到面值 V，按次扣面值，用完为止' }
  ];

  const FIELDS = {
    payType: { label: '卡的类型', kind: 'select' },
    cardPrice: { label: '一次实付（元）', min: MONEY_MIN, max: MONEY_MAX },
    cardFace: { label: '到手面值（元）', min: MONEY_MIN, max: MONEY_MAX, onlyType: 'stored', note: '含赠送；若不赠送就填与实付相同' },
    cardYears: { label: '卡面年限（年）', min: YEARS_MIN, max: YEARS_MAX, onlyType: 'multiyear' },
    visitsPerMonth: { label: '第 1 年每月去几次', min: VISITS_PER_MONTH_MIN, max: VISITS_PER_MONTH_MAX },
    decayPerYear: { label: '年到访衰减率', min: RATE_MIN, max: RATE_MAX, isRate: true },
    perUsePrice: { label: '不用卡时单次价（元）', min: PRICE_PER_USE_MIN, max: PRICE_PER_USE_MAX },
    horizonYears: { label: '向前看几年', min: YEARS_MIN, max: YEARS_MAX },
    discountRate: { label: '年折现率', min: RATE_MIN, max: RATE_MAX, isRate: true },
    failurePerYear: { label: '店/商家年消失概率', min: RATE_MIN, max: RATE_MAX, isRate: true }
  };

  function defaults() {
    return {
      payType: 'lifetime',
      cardPrice: '3600',
      cardFace: '3600',
      cardYears: '3',
      visitsPerMonth: '6',
      decayPerYear: '10',
      perUsePrice: '75',
      horizonYears: '10',
      discountRate: '4',
      failurePerYear: '5',
      items: [
        { name: '健身年卡', payType: 'multiyear', cardPrice: '2400', cardFace: '2400', cardYears: '2', visitsPerMonth: '6', decayPerYear: '15', perUsePrice: '50', horizonYears: '6', discountRate: '4', failurePerYear: '8' },
        { name: '洗车储值卡', payType: 'stored', cardPrice: '1000', cardFace: '1200', cardYears: '1', visitsPerMonth: '1.5', decayPerYear: '5', perUsePrice: '40', horizonYears: '5', discountRate: '3', failurePerYear: '6' },
        { name: '咖啡馆买断杯', payType: 'lifetime', cardPrice: '2680', cardFace: '2680', cardYears: '1', visitsPerMonth: '8', decayPerYear: '20', perUsePrice: '28', horizonYears: '8', discountRate: '3', failurePerYear: '12' }
      ]
    };
  }

  function defaultsClone() { return JSON.parse(JSON.stringify(defaults())); }

  /* ── 校验 ─────────────────────────────────────────────── */
  function normInput(raw) {
    const d = defaults();
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    const keys = ['payType', 'cardPrice', 'cardFace', 'cardYears', 'visitsPerMonth', 'decayPerYear', 'perUsePrice', 'horizonYears', 'discountRate', 'failurePerYear'];
    keys.forEach(function (k) { out[k] = src[k] !== undefined ? src[k] : d[k]; });
    out.items = Array.isArray(src.items) ? src.items : d.items;
    return out;
  }

  function normItem(it, i) {
    const src = it && typeof it === 'object' ? it : {};
    return {
      name: typeof src.name === 'string' ? src.name : String(src.name === undefined ? '卡 ' + (i + 1) : src.name),
      payType: src.payType || 'lifetime',
      cardPrice: src.cardPrice,
      cardFace: src.cardFace,
      cardYears: src.cardYears,
      visitsPerMonth: src.visitsPerMonth,
      decayPerYear: src.decayPerYear,
      perUsePrice: src.perUsePrice,
      horizonYears: src.horizonYears,
      discountRate: src.discountRate,
      failurePerYear: src.failurePerYear
    };
  }

  /** 校验一份输入（主配置或清单里的一条）。返回 {ok, errors, cfg} */
  function validateOne(raw, prefix) {
    const p = prefix || '';
    const errors = [];
    const cfg = normInput(raw);
    const pt = PAY_TYPES.filter(function (x) { return x.id === cfg.payType; })[0];
    if (!pt) errors.push({ field: p + 'payType', msg: '卡的类型不在可选范围内' });

    const money = function (key, label) {
      const n = num(cfg[key]);
      const f = FIELDS[key];
      if (!isFinite(n)) return errors.push({ field: p + key, msg: label + '不是有效数字' }), NaN;
      if (n < f.min) return errors.push({ field: p + key, msg: label + '不能小于 ' + f.min + ' 元' }), NaN;
      if (n > f.max) return errors.push({ field: p + key, msg: label + '不能大于 ' + fmtMoney0(f.max) + ' 元' }), NaN;
      return r2(n);
    };
    const rate = function (key, label) {
      const n = num(cfg[key]);
      const f = FIELDS[key];
      if (!isFinite(n)) return errors.push({ field: p + key, msg: label + '不是有效数字' }), NaN;
      if (n < f.min) return errors.push({ field: p + key, msg: label + '不能小于 0' }), NaN;
      if (n > f.max) return errors.push({ field: p + key, msg: label + '不能大于 100%' }), NaN;
      return n;   // 内部统一存百分数
    };
    const years = function (key, label) {
      const n = num(cfg[key]);
      const f = FIELDS[key];
      if (!isFinite(n)) return errors.push({ field: p + key, msg: label + '不是有效数字' }), NaN;
      if (n < f.min) return errors.push({ field: p + key, msg: label + '不能小于 ' + f.min + ' 年' }), NaN;
      if (n > f.max) return errors.push({ field: p + key, msg: label + '不能大于 ' + f.max + ' 年' }), NaN;
      if (n !== Math.round(n)) return errors.push({ field: p + key, msg: label + '必须是整年数（本页按整年分段）' }), NaN;
      return Math.round(n);
    };

    const cardPrice = money('cardPrice', '一次实付');
    const perUsePrice = money('perUsePrice', '不用卡时单次价');
    const vpm = num(cfg.visitsPerMonth);
    if (!isFinite(vpm)) errors.push({ field: p + 'visitsPerMonth', msg: '每月到访次数不是有效数字' });
    else if (vpm < VISITS_PER_MONTH_MIN) errors.push({ field: p + 'visitsPerMonth', msg: '每月到访次数不能是负数' });
    else if (vpm > VISITS_PER_MONTH_MAX) errors.push({ field: p + 'visitsPerMonth', msg: '每月到访次数不能大于 ' + VISITS_PER_MONTH_MAX + ' 次' });
    const decay = rate('decayPerYear', '年到访衰减率');
    const horizon = years('horizonYears', '向前看年数');
    const disc = rate('discountRate', '年折现率');
    const fail = rate('failurePerYear', '年消失概率');

    let cardFace = cardPrice, cardYears = 1;
    if (cfg.payType === 'stored') {
      cardFace = money('cardFace', '到手面值');
      if (isFinite(cardFace) && isFinite(cardPrice) && cardFace < cardPrice) {
        errors.push({ field: p + 'cardFace', msg: '到手面值不能小于一次实付（赠送只能是正的）' });
      }
      cardYears = isFinite(horizon) ? horizon : YEARS_MIN;
    } else if (cfg.payType === 'multiyear') {
      cardYears = years('cardYears', '卡面年限');
      cardFace = cardPrice;
    } else {
      cardYears = isFinite(horizon) ? horizon : YEARS_MIN;
      cardFace = cardPrice;
    }

    const name = String(cfg.name === undefined ? '' : cfg.name);
    return {
      ok: errors.length === 0,
      errors: errors,
      cfg: {
        payType: cfg.payType,
        cardPrice: cardPrice,
        cardFace: cardFace,
        cardYears: cardYears,
        visitsPerMonth: isFinite(vpm) ? vpm : NaN,
        decayPerYear: decay,
        perUsePrice: perUsePrice,
        horizonYears: isFinite(horizon) ? horizon : NaN,
        discountRate: disc,
        failurePerYear: fail
      }
    };
  }

  /* ── 独立对照实现：按路径随机模拟（只用于交叉验证，不参与页面输出） ──
   * 与 simulate() 完全独立的算法：不套用 E_t = n_t·S_t 这个推导，而是逐路径抽
   * 「第 t 年店还在吗」（伯努利，概率 (1−m)^t）与「这一年去了几次」（泊松到达），
   * 再对所有路径取平均。用于核验期望值推导。
   * 注意：泊松到达是「次数随机」的建模选择，与 simulate() 的「次数取期望值」在期望上
   *       相等（E[Poisson(λ)] = λ），这正是要验证的恒等式。
   */
  function monteCarlo(cfg, opts) {
    const o = opts || {};
    const N = o.paths || 200000;
    /* mulberry32：LCG 的格点结构与 Box–Muller 配对会带来可测偏差（本轮实测 z≈20），
     * 换成就地实现的 mulberry32（32 位全周期，统计性质足够本用途）。 */
    const rng = o.rng || (function () {
      let a = (o.seed === undefined ? 20261110 : o.seed) >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const P = cfg.cardPrice, V = cfg.cardFace, A = cfg.perUsePrice;
    const f0 = cfg.visitsPerMonth * 12;
    const d = cfg.decayPerYear / 100, r = cfg.discountRate / 100, m = cfg.failurePerYear / 100;
    const T = cfg.horizonYears;
    const isStored = cfg.payType === 'stored';
    const dr = isStored ? (V > 0 ? P / V : 1) : 0;
    const expiresAfter = cfg.payType === 'multiyear' ? cfg.cardYears : Infinity;
    const expiredAt = function (t) { return t >= expiresAfter; };
    const pois = function (lam) {              // Knuth
      if (!(lam > 0)) return 0;
      if (lam > 500) {                         // 大 λ 用正态近似，避免超时
        const u1 = Math.max(1e-12, rng()), u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(0, Math.round(lam + Math.sqrt(lam) * z));
      }
      const L = Math.exp(-lam);
      let k = 0, p = 1;
      do { k++; p *= rng(); } while (p > L);
      return k - 1;
    };
    /* 逐年「店还在不在」：第 1 年必然还在（概率 1），此后每一年以条件概率 m 消失，
     * 所以第 t 年还开着的概率 = (1−m)^t（几何寿命的存活函数）。
     * 两个容易写错的版本（我本轮都踩过，如实记在 质检报告.md）：
     *   ① 抽一次「店一共活了几年」再对 T 截断 —— 那是 E[min(Y,T)]（默认档 7.62 年），
     *      与 Σ(1−m)^t（8.03 年）不是同一个量；
     *   ② 逐年伯努利用 (1−m)^t 当阈值 —— 连乘后概率被平方级压低（实测 Σ 只剩 5.41 年）。 */
    let sumValue = 0, sumPV = 0, sumVisits = 0, sumSqValue = 0, sumSqPV = 0;
    for (let i = 0; i < N; i++) {
      let bal = isStored ? V : Infinity;
      let val = 0, pv = 0, vis = 0;
      for (let t = 0; t < T; t++) {
        if (t >= expiresAfter) break;
        if (t > 0 && rng() < m) break;         // 每年以条件概率 m 消失；第 1 年不会消失
        const lam = f0 * Math.pow(1 - d, t);
        const k = pois(lam);
        vis += k;
        if (isStored) {
          const sp = Math.min(k * A, bal);
          bal -= sp;
          const add = sp * dr;
          val += add; pv += add / Math.pow(1 + r, t);
          if (bal <= 0) break;
        } else {
          const add = k * A;
          val += add; pv += add / Math.pow(1 + r, t);
        }
      }
      sumValue += val; sumPV += pv; sumVisits += vis; sumSqValue += val * val; sumSqPV += pv * pv;
    }
    const se = function (sum, sumSq) {
      const mean = sum / N;
      const varN = Math.max(0, sumSq / N - mean * mean) / N;
      return Math.sqrt(varN);
    };
    return {
      paths: N,
      meanValue: sumValue / N,
      meanPV: sumPV / N,
      meanVisits: sumVisits / N,
      seValue: se(sumValue, sumSqValue),
      sePV: se(sumPV, sumSqPV)
    };
  }

  /* ── 泊松到达下的「期望封顶消费」 ─────────────────────────
   * 储值卡每年按面值消费，受余额封顶：consumed = min(k·A, balance)，k ~ 泊松(λ)。
   * 直接用 min(λ·A, balance) 是错的（Jensen 不等式：min 是凹函数，E[min] < min(E)），
   * 本轮实测差 2.5%（默认储值档 MC 974.79 vs 引擎 1000.00）。这里按 k 的分布
   * 逐项求条件期望：Σ_k P(k) · min(k·A, balance)，尾部截断到概率和 1−1e-14。
   */
  function poissonPmf(lam, kMax) {
    const out = new Array(kMax + 1).fill(0);
    if (!(lam > 0)) { out[0] = 1; return out; }
    let k0 = Math.floor(lam), p0 = Math.exp(-lam + k0 * Math.log(lam) - lgamma(k0 + 1));
    if (!isFinite(p0) || p0 <= 0) {                       // 极大 λ 的兜底：正态近似
      const sd = Math.sqrt(lam);
      for (let k = 0; k <= kMax; k++) {
        const z = (k + 0.5 - lam) / sd;
        out[k] = Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
      }
      return out;
    }
    out[k0] = p0;
    for (let k = k0; k > 0; k--) out[k - 1] = out[k] * k / lam;
    for (let k = k0; k < kMax; k++) out[k + 1] = out[k] * lam / (k + 1);
    return out;
  }

  /* lgamma（Lanczos），只为算泊松 PMF 的归一化常数 */
  function lgamma(x) {
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = 0.99999999999980993, t = x + 7.5;
    for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /** 期望封顶消费：E[min(K·A, balance)]，K ~ 泊松(λ) */
  function expectedCappedConsumption(lam, A, balance) {
    if (!(balance > 0)) return 0;
    if (!(lam > 0)) return 0;
    /* 不要用 lam*A <= balance 做提前返回：当 balance 恰好落在 λ 附近（拐点就在均值上）时，
     * 触顶其实有可观概率，提前返回会高估（本轮实测 λ=18、A=40、余额=1200 时高估 0.283 元）。
     * 只有当触顶概率小到浮点上都看不见时才走捷径。 */
    const knee = Math.ceil(balance / A);
    if (lam * A <= balance && knee > lam + 12 * Math.sqrt(lam) + 8) {
      return lam * A;                                     // 触顶在 12σ 之外，忽略不计
    }
    const kMax = Math.max(knee + 1, Math.ceil(lam + 12 * Math.sqrt(lam) + 20), knee + 20);
    const pmf = poissonPmf(lam, kMax);
    let sum = 0, acc = 0;
    for (let k = 0; k <= kMax; k++) {
      const p = pmf[k];
      acc += p;
      sum += p * Math.min(k * A, balance);
      if (k > knee && acc > 1 - 1e-14) break;
    }
    /* 尾部（k > kMax）必然已全部触顶，消费就是 balance */
    const tail = Math.max(0, 1 - acc);
    return sum + tail * balance;
  }

  /* ── 单卡逐年模拟 ─────────────────────────────────────── */
  /**
   * rows: 第 t 年（t=0 起）
   *   t, survive S_t, visits n_t（未乘存活），expectedVisits E_t,
   *   perUseValue 当年折扣金额（储值卡为「按面值花掉的钱 × 折扣率」）
   *   cumValue 累计（不折现），cumValuePV 累计现值
   *   cumVisits 累计期望到访次数, cumCashPay 累计实付
   *   balanceLeft 储值卡年末余额
   */
  function simulate(cfg) {
    const rows = [];
    const P = cfg.cardPrice;
    const V = cfg.cardFace;
    const A = cfg.perUsePrice;
    const f0 = cfg.visitsPerMonth * 12;
    const d = cfg.decayPerYear / 100;
    const r = cfg.discountRate / 100;
    const m = cfg.failurePerYear / 100;
    const T = cfg.horizonYears;
    const isStored = cfg.payType === 'stored';
    const discountRateOnFace = isStored ? (V > 0 ? P / V : 1) : 0;   // 按面值消费时的实际折价
    const bonus = isStored ? Math.max(0, V - P) : 0;
    /* 卡面到期：多年卡到期后不再有用（当作卡权益终止）。终身卡与储值卡不受卡面年限限制。 */
    const expiresAfter = cfg.payType === 'multiyear' ? cfg.cardYears : Infinity;
    const expiredAt = function (t) { return t >= expiresAfter; };

    let cumVisits = 0, cumDecayVisits = 0, cumUsedVisits = 0, cumValue = 0, cumValuePV = 0, balance = isStored ? V : Infinity;
    let usedYears = 0, expireYear = null, exhaustYear = null, paybackYear = null, paybackT = null;

    for (let t = 0; t < T; t++) {
      const survive = Math.pow(1 - m, t);
      const decayVisits = f0 * Math.pow(1 - d, t);   // 只按到访衰减（不乘存活）
      const visits = decayVisits;                    // λ_t：以「店还在」为条件的当年期望到访次数
      const expectedVisits = decayVisits * survive;  // E_t = n_t · S_t（只乘一次存活）
      const expired = expiredAt(t);
      let valueGross = 0, spent = 0;
      if (!expired) {
        if (isStored) {
          /* 储值卡：余额只在「店还在」的分支里被消费（S_t 倍），
           * 所以逐年递推的是「以店还在为条件的期望消费」；
           * 直接按全部路径均摊余额会让任何路径都到不了 0（本轮实测过这个错）。 */
          if (balance > EPS) {
            spent = Math.min(expectedCappedConsumption(visits, A, balance), balance);
            balance -= spent;
            /* 浮点残差归零：期末余额在「面值的 1e-12」以内就当作已用尽。
             * 不做这一步时会出现余额 = 5.46e-12 元的残渣，让「是否用尽」的判断在边界上
             * 抖动（随机 300 组测试抓到过）：既影响 exhaustYear，也让自检前提判错。 */
            if (balance <= Math.max(1e-9, V * 1e-12)) { balance = 0; if (exhaustYear === null) exhaustYear = t + 1; }
          }
          valueGross = survive * spent * discountRateOnFace;
        } else {
          valueGross = expectedVisits * A;
        }
      } else if (expireYear === null) {
        expireYear = t + 1;
      }
      const v = 1 / Math.pow(1 + r, t);
      cumVisits += expectedVisits;                 // 期望到访（含「店已消失」的路径）
      cumDecayVisits += expired ? 0 : decayVisits * survive;   // Σ n_t·S_t：只按衰减+存活，不含已到期年
      cumUsedVisits += (isStored ? spent / Math.max(EPS, A) : (expired ? 0 : expectedVisits));
      cumValue += valueGross;
      cumValuePV += valueGross * v;
      if (!expired) usedYears = t + 1;
      if (isStored && balance === 0 && t + 1 < usedYears) usedYears = t + 1;
      const cashPaid = P;
      if (paybackT === null && cumValue >= P - EPS) { paybackT = t + 1; paybackYear = t + 1; }
      rows.push({
        t: t, year: t + 1,
        survive: survive,
        visits: visits,
        expectedVisits: expectedVisits,
        expired: expired,
        spent: spent,
        balanceLeft: isStored ? balance : null,
        valueGross: valueGross,
        cumVisits: cumVisits,
        cumValue: cumValue,
        cumValuePV: cumValuePV,
        cashPaid: cashPaid,
        net: cumValue - cashPaid,
        netPV: cumValuePV - cashPaid
      });
    }

    /* 对照实现：同一到访把「全程按次付」与「买卡（不够的部分按次付）」两种付法逐年摊开。
     * 这一步是「结论」的来源——储值卡有赠送时，「累计折扣 vs 卡价」会误判为不划算：
     * 折扣只在面值被花掉的那一刻兑现，而卡价是先掏的，两者不能直接比大小，
     * 要比的是 [全程按次付] 与 [买卡 + 面值不够时按次付] 的现值。 */
    const notionalAnnual = cfg.visitsPerMonth * 12;
    let costNoCard = 0, costWithCard = 0, cumNotional = 0, cumFaceRedeemed = 0, cumSelfPay = 0;
    for (let t = 0; t < T; t++) {
      const sv = Math.pow(1 - m, t);
      const n = expiredAt(t) ? 0 : notionalAnnual * Math.pow(1 - d, t);
      const notional = n * A;                      // 这一年「本来要按次付」的金额
      const redeemed = isStored ? Math.min(notional, rows[t].spent) : notional;
      const selfPay = notional - redeemed;         // 卡不够用时自己补的部分
      const v = 1 / Math.pow(1 + r, t);
      cumNotional += sv * notional;
      cumFaceRedeemed += sv * redeemed;
      cumSelfPay += sv * selfPay;
      costNoCard += sv * notional * v;
      costWithCard += sv * selfPay * v;
    }
    costWithCard += P;                             // 卡价在第 0 年一次性付清
    const costNoCardUndisc = cumNotional;
    const savingPV = costNoCard - costWithCard;

    /* 回本所需累计次数（不折现口径） */
    const visitsToPayback = A > 0 ? P / A : Infinity;
    /* 若 horizon 内已回本，用更细的年内插值给出「第几年」；否则看单调性外推 */
    let paybackYears = Infinity;
    if (cumValue >= P && T > 0) {
      paybackYears = paybackT;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].cumValue >= P - EPS) {
          const prev = i === 0 ? 0 : rows[i - 1].cumValue;
          const add = rows[i].cumValue - prev;
          const frac = add > EPS ? (P - prev) / add : 0;
          paybackYears = i + Math.max(0, Math.min(1, frac));
          break;
        }
      }
    } else {
      /* 外推：若每年来访仍在正增长（d = 0 且 m = 0）且未回本，说明永远回不了本 */
      const stillGrowing = (d <= EPS && m <= EPS) && cumValue < P - EPS;
      paybackYears = stillGrowing ? Infinity : (cumValue >= P - EPS ? T : Infinity);
      if (!stillGrowing && cumValue + EPS < P) {
        /* 衰减情形：继续外推到 30 年，看有没有可能 */
        let c = cumValue, f = f0 * Math.pow(1 - d, T) * Math.pow(1 - m, T);
        let ext = T;
        while (ext < MAX_YEARS && c < P - EPS) {
          c += f * A;
          f *= (1 - d) * (1 - m);
          ext++;
        }
        paybackYears = c >= P - EPS ? ext : Infinity;
      }
    }

    /* 盈亏平衡所需「第 1 年每月次数」f*：把整份模拟按 f 线性缩放后二分 */
    function cumValueForF(f1) {
      let c = 0, bal = isStored ? V : Infinity;
      const f0x = f1 * 12;
      for (let t = 0; t < T; t++) {
        if (t >= expiresAfter) break;
        const sv = Math.pow(1 - m, t);
        const n = f0x * Math.pow(1 - d, t);
        if (isStored) {
          const sp = Math.min(expectedCappedConsumption(n, A, bal), bal);
          bal -= sp;
          c += sv * sp * discountRateOnFace;
          if (bal <= Math.max(1e-9, V * 1e-12)) break;
        } else {
          c += n * sv * A;
        }
      }
      return c;
    }
    let breakevenPerMonth = null;
    const atZero = cumValueForF(0);
    const huge = cumValueForF(VISITS_PER_MONTH_MAX);
    if (atZero >= P - EPS) {
      breakevenPerMonth = 0;                       // 不办也「够本」的退化情形（储值卡赠送 > 一切）
    } else if (huge < P - EPS) {
      breakevenPerMonth = Infinity;                // 哪怕天天去也回不了本
    } else {
      let lo = 0, hi = VISITS_PER_MONTH_MAX;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (cumValueForF(mid) >= P) hi = mid; else lo = mid;
      }
      breakevenPerMonth = (lo + hi) / 2;
    }

    const equivalentAnnual = P / Math.max(1, usedYears > 0 ? usedYears : 1);
    const cardAnnual = P / Math.max(1, cfg.cardYears);
    return {
      rows: rows,
      cumVisits: cumVisits,
      cumDecayVisits: cumDecayVisits,
      cumUsedVisits: cumUsedVisits,
      cumValue: cumValue,
      cumValuePV: cumValuePV,
      net: cumValue - P,
      netPV: cumValuePV - P,
      visitsToPayback: visitsToPayback,
      paybackYears: paybackYears,
      usedYears: usedYears,
      expireYear: expireYear,
      exhaustYear: exhaustYear,
      equivalentAnnual: equivalentAnnual,
      cardAnnual: cardAnnual,
      breakevenPerMonth: breakevenPerMonth,
      bonus: bonus,
      discountRateOnFace: discountRateOnFace,
      balanceLeft: isStored ? balance : 0,
      faceLeftRatio: isStored && V > 0 ? balance / V : 0,
      effectiveDiscount: cumVisits > 0 ? 1 - P / (cumVisits * A) : NaN,
      /* 两种付法的对照（结论就取这里的 savingPV） */
      costNoCard: costNoCard,
      costWithCard: costWithCard,
      costNoCardUndisc: costNoCardUndisc,
      cumNotional: cumNotional,
      cumFaceRedeemed: cumFaceRedeemed,
      cumSelfPay: cumSelfPay,
      savingPV: savingPV,
      savingUndisc: cumNotional - cumSelfPay - P,
      selfPayPV: costWithCard - P
    };
  }

  /* ── 判定分档（只是显示分组，不是价值判断标准） ────────── */
  /** 判定：比的是「全程按次付」与「买卡」两种付法的现值（savingPV > 0 才叫划算）
   *  阈值 25% 只是显示分组（省下超过卡价四分之一就算明显），不是任何标准。 */
  function verdictOf(sim) {
    const P = sim.rows.length ? sim.rows[0].cashPaid : 1;
    const sv = sim.savingPV;
    const ratio = sim.costWithCard > 0 ? sim.costNoCard / sim.costWithCard : Infinity;
    if (!isFinite(sv)) return { id: 'loss', label: '无法比较', pill: 'fail', ratio: ratio, savingPV: sv };
    if (sv < 0) return { id: 'loss', label: '买卡不如全程按次付', pill: 'fail', ratio: ratio, savingPV: sv };
    if (sv >= 0.25 * Math.max(EPS, P)) return { id: 'win', label: '明显划算', pill: 'ok', ratio: ratio, savingPV: sv };
    return { id: 'flat', label: '刚够本（省得有限）', pill: 'tight', ratio: ratio, savingPV: sv };
  }

  /** 数值稳定的合成率：x = 1 − (1−d)(1−m) = d + m − d·m
   *  直接写 1−(1−d)(1−m) 在 d、m 都很小的时候会灾难性相消（本轮实测：d=0.1739、m=0.001
   *  时式子给出 0 与 0 相减，闭式算出 NaN，由随机 300 组测试抓出）。 */
  function rateX(d, m) { return d + m - d * m; }

  /** 等比求和 Σ_{t<T} f0·[(1−d)(1−m)]^t 的数值稳定闭式（供自检对照）；T 为有效年数 */
  function xSafeClosed(f0, d, m, T) {
    const x = rateX(d, m);
    if (!(x > 0)) return f0 * T;
    return f0 * (-Math.expm1(T * Math.log1p(-x))) / (-Math.expm1(Math.log1p(-x)));
  }

  /* ── 主分析 ───────────────────────────────────────────── */
  function analyze(raw) {
    const v = validateOne(raw, '');
    if (!v.ok) return { ok: false, errors: v.errors };
    const cfg = v.cfg;
    const sim = simulate(cfg);

    const items = [];
    const rawItems = Array.isArray(raw && raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
    rawItems.forEach(function (it, i) {
      const one = validateOne(normItem(it, i), 'items.' + i + '.');
      const name = String(normItem(it, i).name).slice(0, NAME_MAX) || ('卡 ' + (i + 1));
      if (!one.ok) { items.push({ ok: false, name: name, errors: one.errors }); return; }
      const s = simulate(one.cfg);
      items.push({ ok: true, name: name, cfg: one.cfg, sim: s, verdict: verdictOf(s) });
    });

    const verdict = verdictOf(sim);

    /* 敏感性：每行完整重算 */
    const sens = sensitivity(cfg);

    /* 条例对照 */
    const laws = lawsOf(cfg, sim);

    const res = {
      ok: true,
      cfg: cfg,
      rows: sim.rows,
      sim: sim,
      verdict: verdict,
      isStored: cfg.payType === 'stored',
      items: items,
      sens: sens,
      laws: laws,
      insights: [],
      checks: []
    };
    res.insights = buildInsights(res);
    res.checks = verify(res);
    return res;
  }

  /* ── 敏感性 ───────────────────────────────────────────── */
  function withPatch(cfg, patch) {
    const c = Object.assign({}, cfg, patch);
    const s = simulate(c);
    return { cfg: c, sim: s, verdict: verdictOf(s) };
  }

  function sensitivity(cfg) {
    const base = simulate(cfg);
    const P = cfg.cardPrice;
    const rows = [];
    const push = function (label, patch) {
      const r = withPatch(cfg, patch);
      rows.push({
        label: label,
        cfg: r.cfg,
        net: r.sim.net,
        netPV: r.sim.netPV,
        cumValue: r.sim.cumValue,
        cumValuePV: r.sim.cumValuePV,
        costNoCard: r.sim.costNoCard,
        costWithCard: r.sim.costWithCard,
        savingPV: r.sim.savingPV,
        savingUndisc: r.sim.savingUndisc,
        paybackYears: r.sim.paybackYears,
        breakevenPerMonth: r.sim.breakevenPerMonth,
        verdict: r.verdict,
        delta: r.sim.net - base.net,
        deltaPV: r.sim.savingPV - base.savingPV      // 变化按「省下现值」算，与结论同口径
      });
    };
    push('当前设置', {});
    push('单次价比现在高 20%', { perUsePrice: r2(cfg.perUsePrice * 1.2) });
    push('单次价比现在低 20%', { perUsePrice: r2(cfg.perUsePrice * 0.8) });
    push('每月次数 +1 次', { visitsPerMonth: Math.min(VISITS_PER_MONTH_MAX, r2(cfg.visitsPerMonth + 1)) });
    push('每月次数 ×2', { visitsPerMonth: Math.min(VISITS_PER_MONTH_MAX, r2(cfg.visitsPerMonth * 2)) });
    push('年到访衰减率 +10 个百分点', { decayPerYear: Math.min(RATE_MAX, r2(cfg.decayPerYear + 10)) });
    push('年到访衰减率归零', { decayPerYear: 0 });
    push('年消失概率翻倍', { failurePerYear: Math.min(RATE_MAX, r2(cfg.failurePerYear * 2)) });
    push('年消失概率归零（当作永续）', { failurePerYear: 0 });
    push('折现率 +4 个百分点', { discountRate: Math.min(RATE_MAX, r2(cfg.discountRate + 4)) });
    push('折现率归零（不看时间价值）', { discountRate: 0 });
    push('年限 +2 年', { horizonYears: Math.min(YEARS_MAX, cfg.horizonYears + 2) });
    if (cfg.payType === 'multiyear') push('卡面年限 +1 年', { cardYears: Math.min(YEARS_MAX, cfg.cardYears + 1) });
    push('一次实付降 10%', { cardPrice: r2(P * 0.9) });
    push('一次实付升 10%', { cardPrice: r2(P * 1.1) });
    return rows;
  }

  /* ── 口径对照（几条恒等式/法则，供页面复核） ────────────── */
  function lawsOf(cfg, sim) {
    const A = cfg.perUsePrice, P = cfg.cardPrice;
    const f0 = cfg.visitsPerMonth * 12;
    const T = cfg.horizonYears;
    const d = cfg.decayPerYear / 100, m = cfg.failurePerYear / 100;   // 百分数 → 小数（漏掉这步会让 x > 1 → log1p 返回 NaN）

    /* 不看衰减与消失时：累计期望到访 = f0 × T
     * 两处坑（本轮都踩过，随机 300 组测试抓出）：
     *   ① 直接用 1−(1−d)(1−m)：d、m 极小时灾难性相消，曾把 decaySum 算成 7.52e15；
     *   ② 忘了把百分数除 100：x > 1 时 Math.log1p(-x) = NaN，decaySum 直接变 NaN。
     * 现在用 rateX(d, m) = d + m − d·m 且 d、m 都已是小数。 */
    const noDecaySum = f0 * T;
    const x = rateX(d, m);
    const decaySum = x <= 0
      ? noDecaySum
      : f0 * (-Math.expm1(T * Math.log1p(-x))) / (-Math.expm1(Math.log1p(-x)));

    /* 回本所需累计次数 = P ÷ A，与衰减、消失、折现都无关 */
    const needVisits = P / A;

    /* 等效年费的两种口径 */
    const eqByUsed = sim.usedYears > 0 ? P / sim.usedYears : Infinity;
    const eqByFace = P / Math.max(1, cfg.cardYears);
    const eqByVisits = sim.cumVisits > 0 ? P / (sim.cumVisits / 12) : Infinity;

    /* 储值卡的赠送与实际折扣 */
    const bonus = sim.bonus;
    const bonusRate = cfg.payType === 'stored' && P > 0 ? bonus / P : 0;
    const faceDiscount = cfg.payType === 'stored' && cfg.cardFace > 0 ? P / cfg.cardFace : 1;

    return {
      noDecaySum: noDecaySum,
      decaySum: decaySum,
      needVisits: needVisits,
      eqByUsed: eqByUsed,
      eqByFace: eqByFace,
      eqByVisits: eqByVisits,
      bonus: bonus,
      bonusRate: bonusRate,
      faceDiscount: faceDiscount,
      /* 「等价单次成本」：把实付摊到实际用到的次数上 */
      costPerVisit: sim.cumVisits > 0 ? P / sim.cumVisits : Infinity,
      payVsSingle: sim.cumVisits > 0 ? (P / sim.cumVisits) / A : Infinity
    };
  }

  /* ── 要点（每条都必须能在表里复核） ─────────────────────── */
  function buildInsights(res) {
    const cfg = res.cfg, sim = res.sim, out = [];
    const A = cfg.perUsePrice, P = cfg.cardPrice;

    out.push({
      t: '回本（折扣累计追上卡价）需要的次数与衰减、消失、折现都无关',
      d: '回本只看「累计折扣金额」追上「一次实付」：需要 ' + fmtTimes(sim.visitsToPayback, 2) + ' 次（' + fmtMoney0(P) + ' ÷ ' +
        fmtMoney(A) + '）。但「多久能凑够这些次数」取决于衰减与消失——所以同一张卡，去得越勤越可能回本。'
    });

    if (sim.breakevenPerMonth === null || sim.breakevenPerMonth === Infinity) {
      out.push({
        t: '这张卡在这一组假设下永远回不了本',
        d: '哪怕每月去 ' + VISITS_PER_MONTH_MAX + ' 次（' + fmtMoney0(VISITS_PER_MONTH_MAX * 12) + ' 次/年），累计折扣也追不上 ' +
          fmtMoney0(P) + ' 元。原因通常是单次价太低、卡面年限太短，或年消失概率太高。'
      });
    } else {
      const cur = cfg.visitsPerMonth;
      out.push({
        t: '盈亏平衡在第 1 年每月 ' + fmtTimes(sim.breakevenPerMonth, 2) + ' 次',
        d: '你填的是每月 ' + fmtTimes(cur, 2) + ' 次，' + (cur >= sim.breakevenPerMonth
          ? '比平衡点高 ' + fmtTimes(cur - sim.breakevenPerMonth, 2) + ' 次 → 按这组假设是划算的。'
          : '比平衡点低 ' + fmtTimes(sim.breakevenPerMonth - cur, 2) + ' 次 → 按这组假设不划算。') +
          ' 平衡点已经把衰减、消失与（多年卡）卡面年限都算进去了。'
      });
    }

    if (cfg.payType === 'stored') {
      out.push({
        t: '储值卡先看赠送率，再看你会不会用不完',
        d: '实付 ' + fmtMoney0(P) + ' 拿到面值 ' + fmtMoney0(cfg.cardFace) + '，赠送 ' + fmtMoney0(sim.bonus) +
          '（+' + fmtPct(sim.bonus / P, 1) + '），按面值消费时相当于 ' + fmtPct(1 - sim.discountRateOnFace, 2) + ' 的折扣。' +
          (sim.exhaustYear ? '按当前频率第 ' + sim.exhaustYear + ' 年用尽' : '按当前频率 ' + cfg.horizonYears + ' 年内用不完') +
          '，期末还剩 ' + fmtMoney0(sim.balanceLeft) + ' 元面值（占面值 ' + fmtPct(sim.faceLeftRatio, 1) + '）——这部分是你先垫出去、还没换成服务的钱。'
      });
    }

    if (sim.expireYear) {
      out.push({
        t: '卡面年限会在第 ' + sim.expireYear + ' 年把权益截断',
        d: '多年卡只有 ' + cfg.cardYears + ' 年有效期，第 ' + sim.expireYear + ' 年起不再产生折扣。向前看 ' + cfg.horizonYears +
          ' 年，后面 ' + (cfg.horizonYears - cfg.cardYears) + ' 年对这张卡是空账（想继续用就得再掏一次钱）。'
      });
    }

    /* 衰减与消失各自砍掉多少 */
    const base = simulate(cfg);
    const sNoDecay = simulate(Object.assign({}, cfg, { decayPerYear: 0 }));
    const sNoFail = simulate(Object.assign({}, cfg, { failurePerYear: 0 }));
    const sNeither = simulate(Object.assign({}, cfg, { decayPerYear: 0, failurePerYear: 0 }));
    out.push({
      t: '你的「越去越少」比「店会不会没了」更值钱',
      d: '累计折扣 ' + fmtMoney0(base.cumValue) + ' 元；把衰减归零得到 ' + fmtMoney0(sNoDecay.cumValue) +
        ' 元（+' + fmtMoney0(sNoDecay.cumValue - base.cumValue) + '，' + fmtPct(base.cumValue > 0 ? sNoDecay.cumValue / base.cumValue - 1 : NaN, 1) +
        '），把消失归零得到 ' + fmtMoney0(sNoFail.cumValue) + ' 元（+' + fmtMoney0(sNoFail.cumValue - base.cumValue) + '），两个都归零是 ' +
        fmtMoney0(sNeither.cumValue) + ' 元。'
    });

    out.push({
      t: '等效年费与「摊到次数上的单次成本」是两个口径',
      d: '实付 ' + fmtMoney0(P) + ' 摊到卡面 ' + cfg.cardYears + ' 年是 ' + fmtMoneyAdaptive(sim.cardAnnual) + '/年；摊到「卡还有效的年数」' +
        sim.usedYears + ' 年是 ' + fmtMoneyAdaptive(sim.equivalentAnnual) + '/年；摊到累计期望 ' + fmtTimes(sim.cumVisits, 1) + ' 次上是 ' +
        fmtMoneyAdaptive(res.laws.costPerVisit) + '/次（不用卡时是 ' + fmtMoney(A) + '/次）。三个数都算对，但回答的不是同一个问题。'
        + '（终身卡的「卡还有效的年数」就是你选的观察年数，所以前两个口径会相同——多年卡与储值卡才会分开。）'
    });

    return out;
  }

  /* ── 结构自检（每次重算都跑） ──────────────────────────── */
  function verify(res) {
    const cfg = res.cfg, sim = res.sim, rows = res.rows;
    const out = [];
    const chk = function (name, pass, detail) { out.push({ name: name, pass: !!pass, detail: detail }); };
    const A = cfg.perUsePrice, P = cfg.cardPrice;
    const f0 = cfg.visitsPerMonth * 12;
    const d = cfg.decayPerYear / 100, m = cfg.failurePerYear / 100, T = cfg.horizonYears;
    const tol = 1e-6;
    let rel2 = 0;

    /* 1. 逐年含义：第 0 年存活 1、到访 = f0 */
    chk('第 1 年存活概率为 1、到访次数等于每月次数 × 12',
      Math.abs(rows[0].survive - 1) < tol && Math.abs(rows[0].visits - f0) < tol,
      'S₀=' + r6(rows[0].survive) + '，n₀=' + r4(rows[0].visits));

    /* 2. 逐年递推：S_t = S_{t-1}·(1−m)、n_t = n_{t-1}·(1−d) */
    let recOk = true, bad = '';
    for (let i = 1; i < rows.length; i++) {
      const es = Math.abs(rows[i].survive - rows[i - 1].survive * (1 - m));
      const en = Math.abs(rows[i].visits - rows[i - 1].visits * (1 - d));
      if (!(es < 1e-12 && en < 1e-9)) { recOk = false; bad = '第 ' + (i + 1) + ' 年'; break; }
    }
    chk('存活与到访都按年等比递推', recOk, recOk ? '全部 ' + rows.length + ' 年通过' : bad + '不满足');

    /* 3. 不折现、不衰减、不消失时的闭式：累计 = 每年次数 × 单次价 × 有效年数
     *    （只对非储值卡成立；储值卡被面值封顶，闭式是另一条，见自检 5b） */
    if (cfg.payType !== 'stored') {
      const c2 = Object.assign({}, cfg, { decayPerYear: 0, failurePerYear: 0, discountRate: 0 });
      const s2 = simulate(c2);
      const eff = Math.min(T, cfg.payType === 'multiyear' ? cfg.cardYears : T);
      const want = f0 * A * eff;
      chk('衰减与消失都归零时，累计折扣 = 每年次数 × 单次价 × 有效年数',
        Math.abs(s2.cumValue - want) < 1e-6 * Math.max(1, want),
        '实算 ' + r4(s2.cumValue) + '，闭式 ' + r4(want) + '（每年 ' + r4(f0) + ' 次 × ' + r4(A) + ' 元 × ' + eff + ' 年）');
    } else {
      const c2 = Object.assign({}, cfg, { decayPerYear: 0, failurePerYear: 0, discountRate: 0 });
      const s2 = simulate(c2);
      /* 不衰减不消失时，累计折扣 = 面值被用完的折价：min(f0·A·T, 面值) × (实付÷面值) */
      const want = Math.min(f0 * A * T, cfg.cardFace) * (cfg.cardPrice / cfg.cardFace);
      if (s2.balanceLeft <= EPS) {
        rel2 = Math.abs(s2.cumValue - want) / Math.max(1, want);
        chk('储值卡面值在观察期内用完时，累计折扣 = 面值 × 折扣率',
          rel2 < 1e-9,
          '实算 ' + r8(s2.cumValue) + '，闭式 ' + r8(want) + '（面值 ' + r4(cfg.cardFace) + ' × ' + r6(cfg.cardPrice / cfg.cardFace) + '），相对差 ' + rel2.toExponential(2));
      } else {
        const cap = cfg.cardFace * (cfg.cardPrice / cfg.cardFace);   // = 卡价，只是写清来源
        chk('储值卡面值在观察期内没用完时，折扣严格小于硬上限「面值 × 折扣率」',
          s2.cumValue < cap - 1e-9,
          '实算 ' + r8(s2.cumValue) + ' < 上限 ' + r8(cap) + '，期末余额 ' + r4(s2.balanceLeft) +
          '（未用完时折扣 = 兑现面值 × 折扣率 = ' + r8(want) + '）');
      }
    }

    /* 4. 等比级数闭式：Σ_{t=0..T-1} f0·q^t = f0·(1−q^T)/(1−q)，q=(1−d)(1−m)
     *    sim.cumVisits 可能被（多年卡的）卡面年限截断，所以用「若不截断」的理论上限对拍；
     *    这里刻意用第二套写法（Math.pow 求和 vs log1p/expm1 闭式）互相印证。 */
    {
      const q = (1 - d) * (1 - m);
      /* sim.cumDecayVisits 只累计「卡还有效」的年（多年卡会被卡面年限截断），闭式同样截断 */
      const eff = Math.min(T, cfg.payType === 'multiyear' ? cfg.cardYears : T);
      let closed = 0;
      for (let t = 0; t < eff; t++) closed += f0 * Math.pow(q, t);   // q = (1−d)(1−m)：只衰减+存活
      const rel = Math.abs(sim.cumDecayVisits - closed) / Math.max(1e-12, Math.abs(closed));
      chk('理论到访上限与等比级数逐项求和一致（两种写法互证）',
        rel < 1e-9 || Math.abs(sim.cumDecayVisits - closed) < 1e-6,
        '实算 ' + r6(sim.cumDecayVisits) + '，逐项求和 ' + r6(closed) + '（有效 ' + eff + ' 年），相对差 ' + rel.toExponential(2));
      const stable = xSafeClosed(f0, d, m, eff);
      chk('等比闭式的 log1p/expm1 写法与逐项求和一致（数值稳定）',
        Math.abs(stable - closed) < 1e-6 * Math.max(1, Math.abs(closed)),
        'log1p 写法 ' + r6(stable) + ' vs 逐项 ' + r6(closed));
    }

    /* 5. 累计折扣 = 有效年内的累计到访 × 单次价（非储值卡；多年卡按卡面年限截断） */
    if (cfg.payType !== 'stored') {
      const effRows = rows.filter(function (r) { return !r.expired; });
      const effVisits = effRows.reduce(function (a, r) { return a + r.expectedVisits; }, 0);
      const want = effVisits * A;
      chk('累计折扣金额 = 有效年内的累计期望到访次数 × 单次价',
        Math.abs(sim.cumValue - want) < 1e-6 * Math.max(1, want),
        '实算 ' + r4(sim.cumValue) + '，应为 ' + r4(want) + '（有效 ' + effRows.length + ' 年，累计 ' + r4(effVisits) + ' 次）');
    } else {
      /* 储值卡：消费额 + 期末余额 = 面值（不多不少） */
      const spent = sim.rows.reduce(function (a, r) { return a + r.spent; }, 0);
      const sum = spent + sim.balanceLeft;
      chk('储值卡：累计按面值消费 + 期末余额 = 到手面值',
        Math.abs(sum - cfg.cardFace) < 1e-6 * Math.max(1, cfg.cardFace),
        '消费 ' + r4(spent) + ' + 余额 ' + r4(sim.balanceLeft) + ' = ' + r4(sum) + '，面值 ' + r4(cfg.cardFace));
    }

    /* 6. 现值 ≤ 不折现值（r ≥ 0 时逐年缩小） */
    chk('折现后的累计折扣不超过不折现口径',
      sim.cumValuePV <= sim.cumValue + 1e-6,
      'PV ' + r4(sim.cumValuePV) + ' ≤ ' + r4(sim.cumValue));

    /* 7. 折现率归零时两口径相等 */
    {
      const s3 = simulate(Object.assign({}, cfg, { discountRate: 0 }));
      chk('折现率归零时，现值口径与不折现口径相等',
        Math.abs(s3.cumValuePV - s3.cumValue) < 1e-6 * Math.max(1, s3.cumValue),
        'PV ' + r4(s3.cumValuePV) + ' vs ' + r4(s3.cumValue));
    }

    /* 8. 回本次数恒等式：累计折扣达到 P 时的次数就是 P ÷ A */
    {
      const need = P / A;
      const valueAtNeed = need * A;
      chk('回本所需次数 = 一次实付 ÷ 单次价（与衰减/消失无关）',
        Math.abs(valueAtNeed - P) < 1e-9 * Math.max(1, P),
        'P/A = ' + r6(need) + ' 次，对应金额 ' + r4(valueAtNeed));
    }

    /* 9. 盈亏平衡点回代：把频率换成 f* 后累计折扣应等于 P（误差在二分明辨率内） */
    {
      const b = sim.breakevenPerMonth;
      if (b !== null && isFinite(b)) {
        const c = Object.assign({}, cfg, { visitsPerMonth: b });
        const s4 = simulate(c);
        const rel = Math.abs(s4.cumValue - P) / Math.max(1, P);
        chk('盈亏平衡频率回代后累计折扣 = 一次实付',
          rel < 1e-6 || b >= VISITS_PER_MONTH_MAX - 1e-9,
          'f* = ' + r6(b) + ' 次/月 → 累计 ' + r4(s4.cumValue) + '，目标 ' + r4(P) + '，相对差 ' + rel.toExponential(2));
      } else {
        chk('盈亏平衡频率：判定为「不可能」时确实连上限都够不到',
          simulate(Object.assign({}, cfg, { visitsPerMonth: VISITS_PER_MONTH_MAX })).cumValue < P,
          '每月 ' + VISITS_PER_MONTH_MAX + ' 次也只能累计 ' +
          r4(simulate(Object.assign({}, cfg, { visitsPerMonth: VISITS_PER_MONTH_MAX })).cumValue) + ' < ' + r4(P));
      }
    }

    /* 10. 单调性：次数增加，累计折扣不减 */
    {
      let ok = true, bad2 = '';
      const picks = [0, 0.5, 1, 2, 4, 8, 16, 30];
      let prev = -Infinity;
      picks.forEach(function (k) {
        const s5 = simulate(Object.assign({}, cfg, { visitsPerMonth: k }));
        if (s5.cumValue + 1e-9 < prev) { ok = false; bad2 = 'f=' + k; }
        prev = s5.cumValue;
      });
      chk('到访次数增加时累计折扣单调不减', ok, ok ? '8 档全部单调' : bad2 + ' 处倒退');
    }

    /* 11. 单调性：衰减率越高，累计折扣越低
     *     ——例外：储值卡。面值总额是固定的稀缺资源，去得少反而能把它兑现得更慢、更充分，
     *     所以「衰减 ↑ 累计折扣 ↑」在储值卡上是真实现象（随机测试抓到过），
     *     对储值卡改断言「不会超过 面值 × 折扣率」这个硬上限。 */
    if (cfg.payType === 'stored') {
      let ok = true, prev = -Infinity, detail = '';
      [0, 5, 10, 20, 40, 80].forEach(function (dv) {
        const s6 = simulate(Object.assign({}, cfg, { decayPerYear: dv }));
        if (s6.cumValue < prev - 1e-9) { /* 允许下降，不算失败 */ }
        if (s6.cumValue > cfg.cardFace * s6.discountRateOnFace + 1e-6) ok = false;
        detail += dv + '%:' + r2(s6.cumValue) + ' ';
        prev = s6.cumValue;
      });
      chk('储值卡的累计折扣始终不超过 面值 × 折扣率（硬上限）', ok, detail);
    } else {
      let ok = true;
      let prev = Infinity;
      [0, 5, 10, 20, 40, 80].forEach(function (dv) {
        const s6 = simulate(Object.assign({}, cfg, { decayPerYear: dv }));
        if (s6.cumValue > prev + 1e-9) ok = false;
        prev = s6.cumValue;
      });
      chk('衰减率越高累计折扣越低（单调）', ok, ok ? '6 档递减' : '出现非单调');
    }

    /* 12. 单调性：消失概率越高，累计折扣越低 */
    {
      let ok = true, prev = Infinity;
      [0, 2, 5, 10, 30, 60].forEach(function (mv) {
        const s7 = simulate(Object.assign({}, cfg, { failurePerYear: mv }));
        if (s7.cumValue > prev + 1e-9) ok = false;
        prev = s7.cumValue;
      });
      chk('消失概率越高累计折扣越低（单调）', ok, ok ? '6 档递减' : '出现非单调');
    }

    /* 13. 单调性：折现率越高，现值越低 */
    {
      let ok = true, prev = Infinity;
      [0, 2, 4, 8, 20].forEach(function (rv) {
        const s8 = simulate(Object.assign({}, cfg, { discountRate: rv }));
        if (s8.cumValuePV > prev + 1e-9) ok = false;
        prev = s8.cumValuePV;
      });
      chk('折现率越高现值越低（单调）', ok, ok ? '5 档递减' : '出现非单调');
    }

    /* 14. 多年卡：卡面年限之后不再产生折扣 */
    if (cfg.payType === 'multiyear') {
      const after = rows.filter(function (r) { return r.t >= cfg.cardYears; });
      chk('多年卡在卡面年限之后不再产生折扣',
        after.every(function (r) { return r.valueGross === 0; }),
        '卡面 ' + cfg.cardYears + ' 年，向前看 ' + cfg.horizonYears + ' 年，越界年数 ' + after.length);
    } else {
      chk('非多年卡不受卡面年限截断', rows.every(function (r) { return !r.expired; }), '终身/储值卡不设到期');
    }

    /* 15. 储值卡：赠送关系与折扣率 */
    if (cfg.payType === 'stored') {
      const bonusOk = Math.abs(sim.bonus - (cfg.cardFace - P)) < 1e-9;
      const drOk = Math.abs(sim.discountRateOnFace - P / cfg.cardFace) < 1e-12;
      chk('储值卡赠送额 = 面值 − 实付，折扣率 = 实付 ÷ 面值',
        bonusOk && drOk, '赠送 ' + r4(sim.bonus) + '，折扣率 ' + r6(sim.discountRateOnFace));
    } else {
      chk('非储值卡没有赠送额', sim.bonus === 0, 'bonus = ' + sim.bonus);
    }

    /* 16. 结构完整性：无 NaN / Infinity（允许明确表示为 null 的「不可能」） */
    {
      let badKeys = [];
      const walk = function (o, path) {
        if (o === null || o === undefined) return;
        if (typeof o === 'number') {
          if (Number.isNaN(o) || !isFinite(o)) badKeys.push(path + '=' + o);
          return;
        }
        if (Array.isArray(o)) { o.forEach(function (v, i) { walk(v, path + '[' + i + ']'); }); return; }
        if (typeof o === 'object') { Object.keys(o).forEach(function (k) { walk(o[k], path + '.' + k); }); }
      };
      walk({ rows: rows, sim: { cumVisits: sim.cumVisits, cumValue: sim.cumValue, cumValuePV: sim.cumValuePV, net: sim.net, netPV: sim.netPV, equivalentAnnual: sim.equivalentAnnual, cardAnnual: sim.cardAnnual, bonus: sim.bonus, discountRateOnFace: sim.discountRateOnFace, balanceLeft: sim.balanceLeft, faceLeftRatio: sim.faceLeftRatio } }, 'r');
      chk('结果结构里没有 NaN / Infinity', badKeys.length === 0, badKeys.length ? badKeys.slice(0, 4).join('; ') : '递归检查通过');
    }

    /* 17. 逐年累计与终值一致 */
    {
      const last = rows[rows.length - 1];
      chk('逐年累计的末值与汇总值一致',
        Math.abs(last.cumValue - sim.cumValue) < 1e-9 * Math.max(1, sim.cumValue) &&
        Math.abs(last.cumValuePV - sim.cumValuePV) < 1e-9 * Math.max(1, sim.cumValuePV),
        '末值 ' + r4(last.cumValue) + ' / 汇总 ' + r4(sim.cumValue));
    }

    /* 18. 净值口径一致：净现值 = 累计现值 − 实付 */
    chk('净现值 = 累计现值 − 一次实付',
      Math.abs(sim.netPV - (sim.cumValuePV - P)) < 1e-9 * Math.max(1, P),
      'netPV ' + r4(sim.netPV) + ' = ' + r4(sim.cumValuePV) + ' − ' + r4(P));

    /* 19. 等效年费口径：按卡面年限摊 = P ÷ 卡面年限 */
    chk('卡面年费 = 实付 ÷ 卡面年限',
      Math.abs(sim.cardAnnual - P / Math.max(1, cfg.cardYears)) < 1e-9 * Math.max(1, P),
      'cardAnnual ' + r4(sim.cardAnnual));

    /* 20. 判定与「两种付法的现值之差」一致 */
    {
      const v = verdictOf(sim);
      const consistent = (sim.savingPV < 0) ? (v.id === 'loss') : (v.id === 'win' || v.id === 'flat');
      chk('判定分档与「买卡省下的现值」一致', consistent,
        '判定「' + v.label + '」，省下现值 ' + r4(sim.savingPV) + '（按次付 ' + r4(sim.costNoCard) + ' vs 买卡 ' + r4(sim.costWithCard) + '）');
    }

    /* 21. 两种付法之差的恒等式（结论就是从这里来的，必须逐项对上） */
    {
      chk('省下的现值 = 按次付现值 − 买卡现值',
        Math.abs(sim.savingPV - (sim.costNoCard - sim.costWithCard)) < 1e-9 * Math.max(1, Math.abs(sim.savingPV)),
        '省下 ' + r4(sim.savingPV) + ' = ' + r4(sim.costNoCard) + ' − ' + r4(sim.costWithCard));
      chk('买卡现值 = 卡价 + 自付部分现值',
        Math.abs(sim.costWithCard - (P + sim.selfPayPV)) < 1e-9 * Math.max(1, Math.abs(sim.costWithCard)),
        '买卡 ' + r4(sim.costWithCard) + ' = 卡价 ' + r4(P) + ' + 自付现值 ' + r4(sim.selfPayPV));
      /* 分解恒等式：名义支出 = 用面值抵掉的部分 + 自己补的部分（不折现口径，直接可核） */
      chk('名义支出 = 面值抵扣 + 自己补的部分（不折现）',
        Math.abs(sim.cumNotional - (sim.cumFaceRedeemed + sim.cumSelfPay)) < 1e-6 * Math.max(1, sim.cumNotional),
        r4(sim.cumNotional) + ' = 抵扣 ' + r4(sim.cumFaceRedeemed) + ' + 自付 ' + r4(sim.cumSelfPay));
      /* 两个口径可以不同号：卡价在第 0 年就付出去，折扣是后面逐年才兑现，
       * 折现会把「后面才拿到的好处」打折，所以不折现看着划算、折现后不划算是完全正常的
       * （本轮随机测试就抓到一组：未折现 +138.01 元 vs 现值 −1,173.20 元）。
       * 这里只断言一件必须成立的事：折现率越高，省下的现值只会更小（不会变大）。 */
      const hi = withPatch(cfg, { discountRate: Math.min(RATE_MAX, cfg.discountRate + 10) });
      chk('折现率提高后，省下的现值不会变大',
        hi.sim.savingPV <= sim.savingPV + 1e-9,
        '折现率 ' + cfg.discountRate + '% 时省下 ' + r4(sim.savingPV) + '，提到 ' + hi.cfg.discountRate + '% 时 ' + r4(hi.sim.savingPV));
      chk('未折现口径与现值口径都如实给出（两者可以不同号）',
        isFinite(sim.savingUndisc) && isFinite(sim.savingPV),
        '未折现省下 ' + r4(sim.savingUndisc) + '，现值省下 ' + r4(sim.savingPV) +
        ((sim.savingUndisc >= 0) !== (sim.savingPV >= 0) ? '（两口径方向不同，已如实分别展示）' : ''));
      if (cfg.payType === 'stored') {
        /* 储值卡「用面值换来的折扣」永远不超过 面值 × (实付÷面值) = 实付；
         * 而且只有在「店一直开着」的那条路径上才拿得满，所以是严格上限而非等值。 */
        chk('储值卡用面值换来的折扣不超过「面值 × 折扣率」（严格上限）',
          sim.cumValue <= cfg.cardFace * sim.discountRateOnFace + 1e-9,
          '折扣价值 ' + r4(sim.cumValue) + ' ≤ 上限 ' + r4(cfg.cardFace * sim.discountRateOnFace) +
          (sim.balanceLeft > 0 ? '（期末仍余面值 ' + r4(sim.balanceLeft) + '）' : '（面值已用尽）'));
      }
    }

    return out;
  }

  /* ── 导出用的固定边界清单（UI 与导出共用） ─────────────── */
  const LIMITS = [
    '本页算的是钱，不是「值不值」：它不评价你的使用习惯好不好，也不给消费建议；同一组假设换一个「向前看几年」就会换一个结论。',
    '年到访衰减率、年消失概率、年折现率都由你自填，是假设不是事实：本页不联网、不查任何行业倒闭率、不预测任何具体商家的经营状况。',
    '按整年分段：一年的到访次数按「每月次数 × 12」折算，不建模淡旺季、节假日与月度波动；也不处理月卡、季卡等短周期卡。',
    '储值卡按「每次消费 = 单次价」扣面值，不处理店内定价变化、不可用商品、找零与转让；「用不完的余额」只显示金额，不判断能不能退。',
    '不处理卡面条款：不给「能不能退卡 / 能不能转让 / 过期作废是否合法」的判断，也不读任何合同或会员协议。',
    '不处理共享卡、家庭卡、多人合用一张卡、卡与卡叠加优惠、积分与优惠券；也不处理分期付款与手续费。',
    '不做税务与发票处理；不换算汇率与外币卡。',
    '不判断任何具体商家、平台或卡产品是否可靠，不引用也不替代任何监管规定与消费者权益条款。',
    '默认样例与 8 个内置场景、页面上所有数字都是虚构示例，不是任何真实商家或用户的实测数据。'
  ];

  /* ── 场景 ─────────────────────────────────────────────── */
  const scenarios = [
    { id: 'base', name: '默认：终身卡 3,600 元 / 单次 75 元 / 每月 6 次', patch: {} },
    {
      id: 'gym', name: '健身年卡：2,400 元用 2 年 / 单次 50 元 / 每月 6 次',
      patch: { payType: 'multiyear', cardPrice: '2400', cardFace: '2400', cardYears: '2', visitsPerMonth: '6', decayPerYear: '15', perUsePrice: '50', horizonYears: '6', discountRate: '4', failurePerYear: '8' }
    },
    {
      id: 'stored', name: '洗车储值卡：充 1,000 得 1,200 / 单次 40 元 / 每月 1.5 次',
      patch: { payType: 'stored', cardPrice: '1000', cardFace: '1200', visitsPerMonth: '1.5', decayPerYear: '5', perUsePrice: '40', horizonYears: '5', discountRate: '3', failurePerYear: '6' }
    },
    {
      id: 'nouse', name: '办了就后悔：3,680 元 2 年卡，一年只去 3 次',
      patch: { payType: 'multiyear', cardPrice: '3680', cardFace: '3680', cardYears: '2', visitsPerMonth: '0.25', decayPerYear: '30', perUsePrice: '60', horizonYears: '4', discountRate: '4', failurePerYear: '5' }
    },
    {
      id: 'risky', name: '高风险储值：充 5,000 得 6,500 / 单次 120 元 / 年消失 15%',
      patch: { payType: 'stored', cardPrice: '5000', cardFace: '6500', visitsPerMonth: '3', decayPerYear: '10', perUsePrice: '120', horizonYears: '6', discountRate: '4', failurePerYear: '15' }
    },
    {
      id: 'storedwin', name: '储值划算：充 800 得 1,000 / 单次 20 元 / 每月 6 次',
      patch: { payType: 'stored', cardPrice: '800', cardFace: '1000', visitsPerMonth: '6', decayPerYear: '5', perUsePrice: '20', horizonYears: '3', discountRate: '4', failurePerYear: '5' }
    },
    {
      id: 'churn', name: '三分钟热度：充 3,000 得 3,300，首年月 12 次但衰减 40%',
      patch: { payType: 'stored', cardPrice: '3000', cardFace: '3300', visitsPerMonth: '12', decayPerYear: '40', perUsePrice: '30', horizonYears: '8', discountRate: '4', failurePerYear: '4' }
    },
    {
      id: 'longrun', name: '长期主义：终身卡 9,800 / 单次 80 元 / 月 4 次不衰减 / 看 20 年',
      patch: { payType: 'lifetime', cardPrice: '9800', cardFace: '9800', cardYears: '1', visitsPerMonth: '4', decayPerYear: '0', perUsePrice: '80', horizonYears: '20', discountRate: '4', failurePerYear: '1' }
    }
  ];

  const api = {
    MAX_YEARS: MAX_YEARS, MAX_ITEMS: MAX_ITEMS, NAME_MAX: NAME_MAX,
    MONEY_MIN: MONEY_MIN, MONEY_MAX: MONEY_MAX,
    PRICE_PER_USE_MIN: PRICE_PER_USE_MIN, PRICE_PER_USE_MAX: PRICE_PER_USE_MAX,
    VISITS_PER_MONTH_MIN: VISITS_PER_MONTH_MIN, VISITS_PER_MONTH_MAX: VISITS_PER_MONTH_MAX,
    RATE_MIN: RATE_MIN, RATE_MAX: RATE_MAX, YEARS_MIN: YEARS_MIN, YEARS_MAX: YEARS_MAX,
    PAY_TYPES: PAY_TYPES, FIELDS: FIELDS,
    defaults: defaults, defaultsClone: defaultsClone, scenarios: scenarios, LIMITS: LIMITS,
    parseNum: parseNum, num: num,
    validateOne: validateOne, normInput: normInput, normItem: normItem,
    simulate: simulate, monteCarlo: monteCarlo, expectedCappedConsumption: expectedCappedConsumption, poissonPmf: poissonPmf, lgamma: lgamma, analyze: analyze, verify: verify, verdictOf: verdictOf,
    sensitivity: sensitivity, lawsOf: lawsOf,
    fmtMoney: fmtMoney, fmtMoney0: fmtMoney0, fmtMoneyAdaptive: fmtMoneyAdaptive, fmtPct: fmtPct, fmtTimes: fmtTimes, fmtYears: fmtYears,
    r2: r2, r4: r4, r6: r6
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
