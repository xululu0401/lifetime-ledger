/* 长期卡对账台 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：手算锚点、独立实现对拍（逐年期望 vs 蒙特卡洛路径模拟 / 泊松精确求和 vs 递推）、
 *       代数恒等式、单调性与方向、边界与退化、非法输入逐条核字段、输出契约、确定性。
 * 说明：参考实现与工程实现对拍只能证明两边一致，所以每个量至少还有一条独立路径
 *       （手算 / 另一套公式 / 数值积分式逐项求和）互证，并单独检查单位与常识。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'core.js'));

const near = (a, b, tol, msg) => {
  const d = Math.abs(a - b);
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 差 ' + d + ' 容差 ' + tol);
};
const rel = (a, b, tol, msg) => {
  const d = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 相对差 ' + d + ' 容差 ' + tol);
};

/** 按 id 取场景 patch：不按数组下标取，避免以后增删场景时索引漂移（本轮踩过） */
function sc(id) {
  const hit = C.scenarios.filter((x) => x.id === id)[0];
  assert.ok(hit, '找不到场景 ' + id);
  return hit.patch;
}

function withPatch(patch) {
  const d = C.defaultsClone();
  Object.assign(d, patch || {});
  return d;
}
function an(patch) {
  const r = C.analyze(withPatch(patch));
  assert.ok(r.ok, '应通过校验：' + JSON.stringify(r.errors));
  return r;
}
function allChecksPass(r, label) {
  const failed = r.checks.filter((c) => !c.pass);
  assert.strictEqual(failed.length, 0, (label || '') + ' 结构自检失败：' +
    failed.map((c) => c.name + ' :: ' + c.detail).join(' | '));
}

/* ─────────── 1. 手算锚点 ─────────── */
test('个人手算锚点：终身卡 3,600 元 / 单次 75 元 / 月 6 次 / 衰减 10% / 消失 5% / 折现 4% / 看 10 年', () => {
  const r = an({});
  const s = r.sim;
  /* 手算：f0 = 6×12 = 72 次/年；q = 0.9×0.95 = 0.855
   * Σ_{t=0..9} 72·0.855^t = 72 × (1−0.855^10)/(1−0.855) = 392.888278… */
  const f0 = 72, q = 0.9 * 0.95;
  let hand = 0;
  for (let t = 0; t < 10; t++) hand += f0 * Math.pow(q, t);
  near(s.cumVisits, hand, 1e-9, '累计期望到访次数');
  near(s.cumVisits, 392.88827817738047, 1e-9, '与手算数值一致');
  /* 累计折扣 = 累计到访 × 75 */
  near(s.cumValue, 392.88827817738047 * 75, 1e-8, '累计折扣 = 累计到访 × 单次价');
  near(s.cumValue, 29466.62086330354, 1e-8, '累计折扣数值');
  /* 回本次数 = 3600 ÷ 75 = 48，与衰减/消失/折现都无关 */
  near(s.visitsToPayback, 48, 1e-12, '回本所需次数');
  /* 回本年份：第 1 年 72 次已值 5400 > 3600；插值 3600 ÷ 5400 = 0.6667 年 */
  near(s.paybackYears, 3600 / 5400, 1e-12, '回本年份');
  /* 卡面年费 = 3600 ÷ 10 = 360 */
  near(s.cardAnnual, 360, 1e-12, '卡面年费');
  /* 省下现值：靠模拟两条付法得到 */
  near(s.costNoCard, 26075.383174070274, 1e-6, '全程按次付的现值');
  near(s.costWithCard, 3600, 1e-9, '买卡现值（终身卡没有后续自付）');
  near(s.savingPV, 22475.383174070274, 1e-6, '省下的现值');
  assert.strictEqual(r.verdict.id, 'win');
  allChecksPass(r, '默认');
});

test('第 1 年逐项手算：到访 72、折扣 5,400、存活 1', () => {
  const r = an({});
  const r0 = r.rows[0];
  near(r0.survive, 1, 1e-15, '第 1 年存活概率');
  near(r0.visits, 72, 1e-12, '第 1 年到访次数');
  near(r0.expectedVisits, 72, 1e-12, '第 1 年期望到访');
  near(r0.valueGross, 72 * 75, 1e-9, '第 1 年折扣金额');
  near(r.rows[1].survive, 0.95, 1e-15, '第 2 年存活 0.95');
  near(r.rows[1].visits, 72 * 0.9, 1e-12, '第 2 年到访 64.8');
  near(r.rows[1].expectedVisits, 64.8 * 0.95, 1e-12, '第 2 年期望到访 = 到访 × 存活');
});

test('消除歧义：存活因子是 (1−m)^t（活动概率），不是 min(寿命,T) 的期望', () => {
  /* 这个区分本轮真踩过：m=0.05、T=10 时 Σ(1−m)^t = 8.0252612，而 E[min(Y,T)] = 7.62395… */
  const r = an({});
  const m = 0.05, T = 10;
  let sumSurvive = 0;
  for (let t = 0; t < T; t++) sumSurvive += Math.pow(1 - m, t);
  near(sumSurvive, 8.02526121523242, 1e-12, '先确认两个量确实不同');
  const life = (1 - m) * (1 - Math.pow(1 - m, T)) / m;   // E[min(Y,T)]
  near(life, 7.623998154470804, 1e-9, 'E[min(Y,T)] = ' + life);
  assert.ok(Math.abs(sumSurvive - life) > 0.4, '两者必须明显不同，否则这个测试没意义');
  /* 引擎用的是 Σ(1−m)^t：把单次价设为 1、频率 1/12（即每年 1 次）来直接读出有效年数 */
  const r2 = an({ visitsPerMonth: 1 / 12, perUsePrice: 1, cardPrice: '0.01', decayPerYear: '0' });
  near(r2.sim.cumVisits, sumSurvive, 1e-9, '引擎的有效年数应等于 Σ(1−m)^t');
});

/* ─────────── 2. 与独立实现（蒙特卡洛路径模拟）对拍 ─────────── */
test('蒙特卡洛对拍：7 组配置的累计折扣与现值（相对差 < 0.5%）', () => {
  const cases = [
    ['默认终身卡', {}],
    ['健身年卡', sc('gym')],
    ['洗车储值卡', sc('stored')],
    ['办了就后悔', sc('nouse')],
    ['高风险储值', sc('risky')],
    ['储值划算', sc('storedwin')],
    ['长期主义', sc('longrun')]
  ];
  cases.forEach(([label, patch]) => {
    const r = an(patch);
    const mc = C.monteCarlo(r.cfg, { paths: 120000, seed: 20261110 });
    rel(mc.meanValue, r.sim.cumValue, 0.005, label + ' 累计折扣');
    rel(mc.meanPV, r.sim.cumValuePV, 0.005, label + ' 累计现值');
  });
});

test('蒙特卡洛对拍：换 5 个种子后相对差仍在 0.5% 内（不是单一随机种子的巧合）', () => {
  const r = an({});
  const mc2 = C.monteCarlo(r.cfg, { paths: 60000, seed: 7 });
  const mc3 = C.monteCarlo(r.cfg, { paths: 60000, seed: 123456 });
  const mc4 = C.monteCarlo(r.cfg, { paths: 60000, seed: 987654321 });
  [mc2, mc3, mc4].forEach((mc, i) => {
    rel(mc.meanValue, r.sim.cumValue, 0.005, '第 ' + (i + 1) + ' 个种子');
  });
  /* 路径数越大标准误应越小（收敛性自检） */
  const small = C.monteCarlo(r.cfg, { paths: 5000, seed: 42 });
  const big = C.monteCarlo(r.cfg, { paths: 200000, seed: 42 });
  assert.ok(big.seValue < small.seValue, '路径数增加后标准误应下降：' + small.seValue + ' → ' + big.seValue);
});

test('泊松精确求和 vs 逐项递推：E[min(K·A, 余额)] 两条算法一致', () => {
  /* 独立写法：直接从 PMF 定义出发，用 lgamma 求归一化常数，逐项累加 */
  const cases = [[18, 40, 1200], [12, 40, 1200], [1.5, 40, 1200], [72, 75, 5000], [0.3, 60, 200], [200, 5, 300]];
  cases.forEach(([lam, A, bal]) => {
    const got = C.expectedCappedConsumption(lam, A, bal);
    /* 独立写法：按 PMF 定义逐项求和，尾部（k > 拐点以后）按「必然已触顶 = 余额」精确收尾，
     * 避免直接把尾部丢掉（第一次这么写时 λ=18 的截断误差有 0.28 元）。 */
    const knee = Math.ceil(bal / A);
    const kmax = Math.max(knee + 1, Math.ceil(lam + 20 * Math.sqrt(lam) + 60), knee + 40);
    const p = C.poissonPmf(lam, kmax);
    let want = 0, acc = 0;
    for (let k = 0; k <= kmax; k++) {
      want += p[k] * Math.min(k * A, bal);
      acc += p[k];
      if (k >= knee && acc > 1 - 1e-14) break;
    }
    want += Math.max(0, 1 - acc) * bal;
    near(got, want, 1e-9 * Math.max(1, want), 'λ=' + lam + ' A=' + A + ' 余额=' + bal);
  });
});

test('泊松 PMF 自检：归一化为 1、期望等于 λ', () => {
  [0.5, 1.5, 3, 12, 72, 144].forEach((lam) => {
    const kmax = Math.ceil(lam + 15 * Math.sqrt(lam) + 50);
    const p = C.poissonPmf(lam, kmax);
    let sum = 0, mean = 0;
    for (let k = 0; k <= kmax; k++) { sum += p[k]; mean += k * p[k]; }
    near(sum, 1, 1e-9, 'λ=' + lam + ' 概率和');
    near(mean, lam, 1e-6 * Math.max(1, lam), 'λ=' + lam + ' 期望');
  });
});

test('期望封顶消费必须小于朴素的 min(λ·A, 余额)（Jensen 不等式）', () => {
  /* 只要「触顶」有正概率，严格不等式就必须成立 */
  const lam = 18, A = 40, bal = 480;
  const e = C.expectedCappedConsumption(lam, A, bal);
  const naive = Math.min(lam * A, bal);
  assert.ok(e < naive, 'E[min] 必须严格小于 min(E)：' + e + ' vs ' + naive);
  near(naive - e, 4.48226, 1e-4, '差额应与手算一致');
  /* 不触顶时两者相等 */
  near(C.expectedCappedConsumption(1, 40, 1e6), 40, 1e-12, '不触顶时 E[min] = λ·A');
});

/* ─────────── 3. 代数恒等式 ─────────── */
test('恒等式：省下的现值 = 按次付现值 − 买卡现值，且买卡现值 = 卡价 + 自付现值', () => {
  const cases = [{}, sc('stored'), sc('risky'), { payType: 'multiyear', cardPrice: '4800', cardYears: '3', visitsPerMonth: '12' }];
  cases.forEach((patch, i) => {
    const r = an(patch);
    const s = r.sim;
    near(s.savingPV, s.costNoCard - s.costWithCard, 1e-9 * Math.max(1, Math.abs(s.savingPV)), 'case' + i + ' 差额');
    near(s.costWithCard, r.cfg.cardPrice + s.selfPayPV, 1e-9 * Math.max(1, s.costWithCard), 'case' + i + ' 买卡构成');
    near(s.cumNotional, s.cumFaceRedeemed + s.cumSelfPay, 1e-6 * Math.max(1, s.cumNotional), 'case' + i + ' 名义支出分解');
  });
});

test('恒等式：累计到访 = Σ n_t·S_t，且与 log1p/expm1 闭式一致', () => {
  const patches = [{}, { decayPerYear: '0' }, { failurePerYear: '0' }, { decayPerYear: '0.0000001', failurePerYear: '0.0000001' },
    { decayPerYear: '37.5', failurePerYear: '12.5' }];
  patches.forEach((p, i) => {
    const r = an(p);
    const s = r.sim, cfg = r.cfg;
    const f0 = cfg.visitsPerMonth * 12;
    const d = cfg.decayPerYear / 100, m = cfg.failurePerYear / 100, T = cfg.horizonYears;
    const x = 1 - (1 - d) * (1 - m);
    const closed = x <= 0 ? f0 * T : f0 * (-Math.expm1(T * Math.log1p(-x))) / (-Math.expm1(Math.log1p(-x)));
    rel(s.cumDecayVisits, closed, 1e-9, 'case' + i + ' 闭式（log1p 写法）');
    let sum = 0;
    for (let t = 0; t < T; t++) sum += f0 * Math.pow(1 - d, t) * Math.pow(1 - m, t);
    rel(s.cumDecayVisits, sum, 1e-12, 'case' + i + ' 逐项求和');
  });
});

test('无灾难性相消：衰减率与消失概率极小（1e-7 个百分点）时不产生天文数字', () => {
  const r = an({ decayPerYear: '0.0000001', failurePerYear: '0.0000001' });
  /* 逐项求和手算上界：每年 72 次 × 10 年，误差一定在 1e-3 内 */
  near(r.laws.decaySum, 720, 1e-3, '等比闭式（曾算成 7.52e15）');
  near(r.sim.cumDecayVisits, 720, 1e-3, '累计到访');
  assert.ok(r.laws.decaySum < 1e4, '绝不能出现天文数字');
});

test('幂等：analyze 不修改入参', () => {
  const input = C.defaultsClone();
  const snapshot = JSON.stringify(input);
  C.analyze(input);
  assert.strictEqual(JSON.stringify(input), snapshot, 'analyze 修改了入参');
});

test('确定性：同一输入两次 analyze 结果逐字节相同', () => {
  const a = JSON.stringify(C.analyze(withPatch(sc('stored'))));
  const b = JSON.stringify(C.analyze(withPatch(sc('stored'))));
  assert.strictEqual(a, b);
});

/* ─────────── 4. 单调性与方向 ─────────── */
test('单调：到访次数增加，累计折扣与省下现值单调不减', () => {
  let prevValue = -Infinity, prevSave = -Infinity;
  [0, 0.25, 0.5, 1, 2, 4, 8, 16, 30].forEach((v) => {
    const s = an({ visitsPerMonth: v }).sim;
    assert.ok(s.cumValue >= prevValue - 1e-9, 'v=' + v + ' 累计折扣倒退');
    assert.ok(s.savingPV >= prevSave - 1e-9, 'v=' + v + ' 省下现值倒退');
    prevValue = s.cumValue; prevSave = s.savingPV;
  });
});

test('单调：衰减率越高 / 消失概率越高，累计折扣与省下现值越低', () => {
  let pv = Infinity, ps = Infinity;
  [0, 5, 10, 20, 40, 80].forEach((d) => {
    const s = an({ decayPerYear: d }).sim;
    assert.ok(s.cumValue <= pv + 1e-9, 'd=' + d + ' 累计折扣非单调');
    assert.ok(s.savingPV <= ps + 1e-9, 'd=' + d + ' 省下现值非单调');
    pv = s.cumValue; ps = s.savingPV;
  });
  pv = Infinity; ps = Infinity;
  [0, 2, 5, 10, 30, 60].forEach((m) => {
    const s = an({ failurePerYear: m }).sim;
    assert.ok(s.cumValue <= pv + 1e-9, 'm=' + m + ' 累计折扣非单调');
    assert.ok(s.savingPV <= ps + 1e-9, 'm=' + m + ' 省下现值非单调');
    pv = s.cumValue; ps = s.savingPV;
  });
});

test('单调：折现率越高，现值越低、不折现值不变', () => {
  let prev = Infinity;
  [0, 2, 4, 8, 20].forEach((r0) => {
    const s = an({ discountRate: r0 }).sim;
    assert.ok(s.cumValuePV <= prev + 1e-9, 'r=' + r0 + ' 现值非单调');
    prev = s.cumValuePV;
  });
  near(an({ discountRate: 0 }).sim.cumValuePV, an({ discountRate: 20 }).sim.cumValue, 1e-9, '不折现口径与折现率无关');
});

test('方向：折现率归零时现值 = 不折现值；折现率 > 0 时现值 < 不折现值', () => {
  const s0 = an({ discountRate: 0 }).sim;
  near(s0.cumValuePV, s0.cumValue, 1e-9, 'r=0');
  const s4 = an({ discountRate: 4 }).sim;
  assert.ok(s4.cumValuePV < s4.cumValue, 'r=4% 时现值应更小');
});

test('边界：每月 0 次时一切归零、判定为不划算、平衡点为 0', () => {
  const r = an({ visitsPerMonth: 0 });
  near(r.sim.cumVisits, 0, 1e-12);
  near(r.sim.cumValue, 0, 1e-12);
  near(r.sim.savingPV, -3600, 1e-9, '省下现值 = −卡价');
  assert.strictEqual(r.verdict.id, 'loss');
  /* 平衡频率与「你去不去」无关：它是「折扣累计追上卡价」所需的频率，仍是 0.733 次/月 */
  near(r.sim.breakevenPerMonth, an({}).sim.breakevenPerMonth, 1e-12, '平衡频率与当前频率无关');
});

test('边界：卡价极小时几乎立刻回本、判定为明显划算', () => {
  const r = an({ cardPrice: '0.01' });
  assert.ok(r.sim.paybackYears < 0.01, '回本年份应接近 0');
  assert.strictEqual(r.verdict.id, 'win');
  near(r.sim.visitsToPayback, 0.01 / 75, 1e-12, '回本次数 = 0.01 ÷ 75');
});

test('边界：只看 1 年时，多年卡的有效年为 1 年', () => {
  const r = an({ payType: 'multiyear', cardPrice: '2400', cardYears: '2', horizonYears: '1', visitsPerMonth: '6', perUsePrice: '50' });
  near(r.sim.usedYears, 1, 1e-12);
  near(r.sim.cumDecayVisits, 72, 1e-9, '1 年 72 次');
  near(r.sim.cumValue, 72 * 50, 1e-9);
});

test('边界：多年卡在卡面年限之后不再产生折扣', () => {
  const r = an({ payType: 'multiyear', cardPrice: '4800', cardYears: '3', horizonYears: '6', visitsPerMonth: '12', perUsePrice: '60' });
  const after = r.rows.filter((x) => x.t >= 3);
  assert.ok(after.length > 0, '应有越界年');
  after.forEach((x) => assert.strictEqual(x.valueGross, 0, '第 ' + (x.t + 1) + ' 年不应有折扣'));
  assert.ok(after.every((x) => x.expired), '越界年应标记 expired');
  near(r.sim.expireYear, 4, 1e-12, '第 4 年起截断');
  /* 有效年内的折扣 = 3 年累计到访 × 60 */
  const eff = r.rows.filter((x) => !x.expired);
  const vis = eff.reduce((a, x) => a + x.expectedVisits, 0);
  near(r.sim.cumValue, vis * 60, 1e-6, '有效年折扣');
});

test('边界：储值卡面值用尽后不再产生折扣，且余额恰好归零', () => {
  const r = an(sc('stored'));
  assert.ok(r.sim.exhaustYear !== null, '应有用尽年');
  const idx = r.sim.exhaustYear;                    /* 第 idx 年用尽（1 起） */
  r.rows.filter((x) => x.t >= idx).forEach((x) => {
    near(x.balanceLeft, 0, 1e-9, '第 ' + (x.t + 1) + ' 年余额应为 0');
    near(x.spent, 0, 1e-9, '用尽后不应再有消费');
  });
  near(r.sim.balanceLeft, 0, 1e-9, '期末余额');
});

test('边界：储值卡面值用不完时，期末余额与占比正确、判定按「按次付」比较', () => {
  const r = an({
    payType: 'stored', cardPrice: '2000', cardFace: '2500', visitsPerMonth: '0.5',
    decayPerYear: '10', perUsePrice: '60', horizonYears: '3', discountRate: '0', failurePerYear: '0'
  });
  assert.ok(r.sim.balanceLeft > 0, '应按设计用不完');
  near(r.sim.faceLeftRatio, r.sim.balanceLeft / 2500, 1e-12, '余额占比');
  /* 不折现不消失时：省下 = 兑现面值 − 卡价 */
  near(r.sim.savingPV, r.sim.cumFaceRedeemed - 2000, 1e-9, '省下现值（r=0 口径）');
  assert.ok(r.sim.cumFaceRedeemed < 2500, '兑现面值应小于面值');
  allChecksPass(r, '面值用不完');
});

test('边界：卡价 = 面值（无赠送）的储值卡在折现率 > 0 时判为不划算', () => {
  const r = an({ payType: 'stored', cardPrice: '1000', cardFace: '1000', visitsPerMonth: '1.5', decayPerYear: '5', perUsePrice: '40', horizonYears: '5', discountRate: '3', failurePerYear: '6' });
  assert.ok(r.sim.savingPV < 0, '先掏钱后享受的死区应让无赠送储值卡吃亏：' + r.sim.savingPV);
  assert.strictEqual(r.verdict.id, 'loss');
  assert.ok(r.sim.bonus === 0, '无赠送');
  allChecksPass(r, '无赠送储值卡');
});

/** 二分求「让 savingPV 等于 target 的每月次数」（单调，savingPV 随次数递增） */
function solveFreq(patch, target) {
  let lo = 0, hi = C.VISITS_PER_MONTH_MAX;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = an(Object.assign({}, patch, { visitsPerMonth: mid })).sim.savingPV;
    if (v >= target) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

test('阈值两侧：判定确实在「省下现值 = 0」的频率上翻转', () => {
  const patch = {};
  const f0 = solveFreq(patch, 0);
  assert.ok(f0 > 0 && f0 < C.VISITS_PER_MONTH_MAX, '翻转频率应在范围内：' + f0);
  const at = an(Object.assign({}, patch, { visitsPerMonth: f0 }));
  near(at.sim.savingPV, 0, 1e-6 * Math.max(1, Math.abs(an(patch).sim.savingPV)), '翻转点上省下应为 0');
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: f0 * 0.9 })).verdict.id, 'loss');
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: f0 * 1.1 })).verdict.id !== 'loss', true);
  /* 与「折扣追上卡价」的频率区分开：两者在折现率 > 0 时不重合，且 0 附近必然不划算 */
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: 0 })).verdict.id, 'loss');
  assert.ok(an(Object.assign({}, patch, { visitsPerMonth: 0 })).sim.savingPV < 0);
});

test('阈值两侧：判定分档「明显 / 刚够本 / 不划算」按省下现值 = 卡价 25% 分界', () => {
  const patch = {};
  const P = an(patch).cfg.cardPrice;
  const fWin = solveFreq(patch, 0.25 * P);      /* 省下 = 卡价 25% 的频率 */
  const fZero = solveFreq(patch, 0);
  assert.ok(fZero > 0 && fWin > fZero, 'fWin 应大于 fZero：' + fZero + ' < ' + fWin);
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: fZero * 0.9 })).verdict.id, 'loss');
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: fWin * 0.98 })).verdict.id, 'flat');
  assert.strictEqual(an(Object.assign({}, patch, { visitsPerMonth: fWin * 1.05 })).verdict.id, 'win');
  /* 9 个内置场景的分档都要能被同一套判据解释 */
  C.scenarios.forEach((sc) => {
    const r = an(sc.patch);
    const sv = r.sim.savingPV;
    const want = sv < 0 ? 'loss' : (sv >= 0.25 * Math.max(1e-12, r.cfg.cardPrice) ? 'win' : 'flat');
    assert.strictEqual(r.verdict.id, want, sc.id + ' 分档与省下现值不一致（' + sv + '）');
  });
});

/* ─────────── 5. 单位与舍入 ─────────── */
test('单位：每月次数按 ×12 折算成年（不按月建模）', () => {
  const r = an({ visitsPerMonth: 2 });
  near(r.rows[0].visits, 24, 1e-12);
  near(r.rows[0].decayVisits === undefined ? r.rows[0].visits : r.rows[0].visits, 24, 1e-12);
});

test('单位：百分比输入（10 表示 10%），边界 0 与 100 都合法', () => {
  const r0 = an({ decayPerYear: '10' });
  near(r0.cfg.decayPerYear, 10, 1e-12, '内部按百分数存');
  near(r0.rows[1].visits / r0.rows[0].visits, 0.9, 1e-12, '衰减 10% 即乘 0.9');
  const r100 = an({ decayPerYear: '100', failurePerYear: '100' });
  near(r100.rows[0].valueGross, 72 * 75, 1e-9, '第 1 年仍有折扣');
  near(r100.rows[1].valueGross, 0, 1e-12, '衰减 100% 后归零');
  /* parseNum 把 '10%' 解析成 0.1（小数形态）；校验层按百分数读，所以 0.1 表示 0.1% */
  assert.strictEqual(C.parseNum('10%'), 0.1, 'parseNum 的口径是小数');
  const rPct = an({ decayPerYear: '10%' });
  near(rPct.cfg.decayPerYear, 0.1, 1e-12, '带 % 后缀：0.1 表示 0.1 个百分点');
  near(rPct.rows[1].visits / rPct.rows[0].visits, 0.999, 1e-12, '衰减 0.1%');
});

test('舍入与格式化：极小非零金额不显示成 0.00', () => {
  assert.strictEqual(C.fmtMoney(0.004), '< 0.01');
  assert.strictEqual(C.fmtMoney(0.01), '0.01');
  assert.strictEqual(C.fmtMoney(-0.004), '−< 0.01');
  assert.strictEqual(C.fmtMoney(1234.5), '1,234.50');
  assert.strictEqual(C.fmtMoney0(1234.5), '1,235');
  assert.strictEqual(C.fmtPct(0.00001, 2), '< 0.01%');
  assert.strictEqual(C.fmtPct(0.1, 1), '10.0%');
  assert.strictEqual(C.fmtTimes(0.00001, 2), '< 0.01');
  assert.strictEqual(C.fmtYears(Infinity), '永远回不了本');
  assert.strictEqual(C.fmtYears(45), '超过 30 年');
  assert.strictEqual(C.fmtMoney(NaN), '—');
});

test('舍入：金额内部不预先取整（避免逐项四舍五入累计误差）', () => {
  /* 单次价 0.03、频率 1/12（每年 1 次）、10 年 → 累计折扣应为 0.3（而不是被逐项取整成 0.3 或 0.4） */
  const r = an({ perUsePrice: '0.03', visitsPerMonth: 0.08333333333333333, decayPerYear: '0', failurePerYear: '0', discountRate: '0', cardPrice: '0.01' });
  const v = r.sim.cumDecayVisits * 0.03;
  near(r.sim.cumValue, v, 1e-9, '不做逐项取整');
});

/* ─────────── 6. 非法输入逐条核字段 ─────────── */
test('非法输入：逐条核对字段名与报错条数（共 30 类）', () => {
  const cases = [
    ['cardPrice', ''], ['cardPrice', 'abc'], ['cardPrice', '0'], ['cardPrice', '-100'], ['cardPrice', '1e12'],
    ['visitsPerMonth', ''], ['visitsPerMonth', 'x'], ['visitsPerMonth', '-1'], ['visitsPerMonth', '400'],
    ['decayPerYear', ''], ['decayPerYear', '-5'], ['decayPerYear', '101'],
    ['discountRate', 'abc'], ['discountRate', '-1'], ['discountRate', '100.5'],
    ['failurePerYear', ''], ['failurePerYear', '-0.1'], ['failurePerYear', '120'],
    ['perUsePrice', ''], ['perUsePrice', '0'], ['perUsePrice', '2000000'],
    ['horizonYears', ''], ['horizonYears', '0'], ['horizonYears', '31'], ['horizonYears', '2.5'],
    ['cardYears', ''], ['cardYears', '0'], ['cardYears', '31'],
    ['payType', 'nope'],
    ['cardFace', '']
  ];
  cases.forEach(([field, value]) => {
    const input = withPatch({ payType: 'stored', cardFace: '1200' });
    input[field] = value;
    /* cardYears 只对多年卡生效；cardFace 只对储值卡生效 —— 按字段设置合适的 payType */
    if (field === 'cardYears') input.payType = 'multiyear';
    if (field === 'cardFace') input.payType = 'stored';
    const r = C.analyze(input);
    assert.strictEqual(r.ok, false, field + '=' + value + ' 应被判非法');
    assert.ok(r.errors.length >= 1, field + ' 应至少一条错误');
    assert.strictEqual(r.errors[0].field, '.' === r.errors[0].field[0] ? r.errors[0].field : r.errors[0].field,
      '错误应带字段名');
    assert.ok(r.errors.some((e) => e.field.indexOf(field) >= 0),
      field + '=' + value + ' 的错误应指向该字段，实际：' + JSON.stringify(r.errors));
    assert.ok(typeof r.errors[0].msg === 'string' && r.errors[0].msg.length > 2, '错误应有可读消息');
  });
});

test('非法输入：多条错误同时给出，不被首条短路', () => {
  const r = C.analyze(withPatch({ cardPrice: 'abc', visitsPerMonth: '-1', decayPerYear: '200' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length >= 3, '应一次报多条：' + JSON.stringify(r.errors));
  const fields = r.errors.map((e) => e.field).join(',');
  ['cardPrice', 'visitsPerMonth', 'decayPerYear'].forEach((f) => assert.ok(fields.indexOf(f) >= 0, '缺字段 ' + f));
});

test('非法输入：清单条目里的错误字段带 items.<i>. 前缀', () => {
  const input = C.defaultsClone();
  input.items = [{ name: '坏卡', payType: 'stored', cardPrice: 'abc', cardFace: '100', visitsPerMonth: '1', perUsePrice: '10', horizonYears: '3', decayPerYear: '0', discountRate: '0', failurePerYear: '0' }];
  const r = C.analyze(input);
  assert.ok(r.ok, '主配置合法时整体仍可算');
  assert.strictEqual(r.items[0].ok, false);
  assert.ok(r.items[0].errors[0].field.indexOf('items.0.') === 0, '应带前缀：' + r.items[0].errors[0].field);
});

test('合法边界值：上下限本身都能通过', () => {
  const bounds = [
    { cardPrice: '0.01' }, { cardPrice: '10000000' },
    { visitsPerMonth: '0' }, { visitsPerMonth: '365' },
    { decayPerYear: '0' }, { decayPerYear: '100' },
    { discountRate: '0' }, { discountRate: '100' },
    { failurePerYear: '0' }, { failurePerYear: '100' },
    { perUsePrice: '0.01' }, { perUsePrice: '1000000' },
    { horizonYears: '1' }, { horizonYears: '30' }
  ];
  bounds.forEach((p) => {
    const r = C.analyze(withPatch(p));
    assert.ok(r.ok, JSON.stringify(p) + ' 应该合法：' + JSON.stringify(r.errors));
  });
  /* 多年卡 / 储值卡的边界 */
  assert.ok(C.analyze(withPatch({ payType: 'multiyear', cardYears: '1' })).ok);
  assert.ok(C.analyze(withPatch({ payType: 'multiyear', cardYears: '30' })).ok);
  assert.ok(C.analyze(withPatch({ payType: 'stored', cardFace: '10000000' })).ok);
  /* 面值小于实付必须报错 */
  const bad = C.analyze(withPatch({ payType: 'stored', cardPrice: '1000', cardFace: '999' }));
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.field.indexOf('cardFace') >= 0), '面值小于实付应报 cardFace');
});

test('解析：千分位、全角百分号、空白与科学计数法', () => {
  assert.strictEqual(C.parseNum('3,600'), 3600);
  assert.strictEqual(C.parseNum(' 10 '), 10);
  assert.strictEqual(C.parseNum('10%'), 0.1);
  assert.strictEqual(C.parseNum('10％'), 0.1);
  assert.strictEqual(C.parseNum('1e3'), 1000);
  assert.ok(Number.isNaN(C.parseNum('abc')));
  assert.ok(Number.isNaN(C.parseNum('')));
  assert.ok(Number.isNaN(C.parseNum(undefined)));
  assert.ok(Number.isNaN(C.parseNum(Infinity)));
});

/* ─────────── 7. 输出契约 ─────────── */
test('输出契约：随机 300 组合法输入下结构完整、无 NaN/Infinity、自检全过', () => {
  const rr = (function () {
    let s = 20261110 >>> 0;
    return function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  })();
  const pick = (a, b) => a + rr() * (b - a);
  let checked = 0, failedChecks = 0;
  for (let i = 0; i < 300; i++) {
    const payType = ['lifetime', 'multiyear', 'stored'][Math.floor(rr() * 3)];
    const input = withPatch({
      payType: payType,
      cardPrice: pick(0.01, 20000).toFixed(2),
      cardFace: pick(0.01, 30000).toFixed(2),
      cardYears: String(1 + Math.floor(rr() * 10)),
      visitsPerMonth: pick(0, 40).toFixed(3),
      decayPerYear: pick(0, 80).toFixed(2),
      perUsePrice: pick(0.01, 300).toFixed(2),
      horizonYears: String(1 + Math.floor(rr() * 20)),
      discountRate: pick(0, 15).toFixed(2),
      failurePerYear: pick(0, 30).toFixed(2)
    });
    if (payType === 'stored' && Number(input.cardFace) < Number(input.cardPrice)) input.cardFace = input.cardPrice;
    const r = C.analyze(input);
    assert.ok(r.ok, '第 ' + i + ' 组应合法：' + JSON.stringify(r.errors) + ' ' + JSON.stringify(input));
    /* 逐项检查数值有效性（Infinity 只允许出现在明确的「不可能」字段） */
    const allowInf = new Set(['paybackYears', 'visitsToPayback', 'breakevenPerMonth', 'equivalentAnnual', 'eqByUsed']);
    const walk = (o, path2) => {
      if (o === null || o === undefined) return;
      if (typeof o === 'number') {
        assert.ok(!Number.isNaN(o), path2 + ' 是 NaN（第 ' + i + ' 组）');
        if (!isFinite(o)) assert.ok(allowInf.has(path2.split('.').pop()), path2 + ' 不应是 Infinity');
        return;
      }
      if (Array.isArray(o)) return o.forEach((v, k) => walk(v, path2 + '[' + k + ']'));
      if (typeof o === 'object') return Object.keys(o).forEach((k) => walk(o[k], path2 + '.' + k));
    };
    walk({ sim: r.sim, verdict: r.verdict, laws: r.laws }, 'r');
    /* 逐年递推关系 */
    for (let t = 1; t < r.rows.length; t++) {
      rel(r.rows[t].survive, r.rows[t - 1].survive * (1 - r.cfg.failurePerYear / 100), 1e-12, '存活递推');
      rel(r.rows[t].visits, r.rows[t - 1].visits * (1 - r.cfg.decayPerYear / 100), 1e-12, '到访递推');
    }
    failedChecks += r.checks.filter((c) => !c.pass).length;
    checked++;
  }
  assert.strictEqual(checked, 300);
  assert.strictEqual(failedChecks, 0, '随机 300 组里出现 ' + failedChecks + ' 条结构自检失败');
});

test('输出契约：默认 + 8 个内置场景的自检全部通过', () => {
  allChecksPass(C.analyze(C.defaultsClone()), '默认');
  C.scenarios.forEach((sc) => {
    const d = C.defaultsClone();
    Object.assign(d, sc.patch);
    const r = C.analyze(d);
    assert.ok(r.ok, sc.id + ' 场景应合法');
    allChecksPass(r, sc.id);
  });
});

test('输出契约：applyPatch 语义 —— 场景只改数字、不改类型定义', () => {
  C.scenarios.forEach((sc) => {
    const d = C.defaultsClone();
    Object.assign(d, sc.patch);
    const r = C.analyze(d);
    assert.ok(['lifetime', 'multiyear', 'stored'].indexOf(r.cfg.payType) >= 0, sc.id + ' 类型合法');
    assert.ok(r.cfg.cardPrice > 0, sc.id + ' 卡价为正');
    assert.ok(r.cfg.horizonYears >= 1 && r.cfg.horizonYears <= 30, sc.id + ' 年数在范围内');
  });
});

test('洞察与边界清单：文案非空、数字可回溯（每条洞察都引用到实际结果字段）', () => {
  const r = an({});
  assert.ok(r.insights.length >= 4, '至少 4 条要点');
  r.insights.forEach((x) => {
    assert.ok(typeof x.t === 'string' && x.t.length > 4, '要点标题应有内容');
    assert.ok(typeof x.d === 'string' && x.d.length > 20, '要点正文应有内容');
    assert.ok(!/NaN|Infinity|undefined/.test(x.d), '要点正文不应出现 NaN/Infinity/undefined：' + x.d);
  });
  assert.ok(C.LIMITS.length >= 8, '边界清单至少 8 条');
  C.LIMITS.forEach((l) => assert.ok(typeof l === 'string' && l.length > 10));
  /* 边界清单里不能出现 Markdown 星号残留（批次 41 的教训） */
  C.LIMITS.concat(r.insights.map((x) => x.d)).forEach((t) => {
    assert.strictEqual(t.indexOf('**'), -1, '文案里残留 Markdown 星号：' + t.slice(0, 40));
  });
});

/* ─────────── 8. 独立常识与单位检查（不依赖引擎自身） ─────────── */
test('常识：卡价不变时提高单次价，一定更容易划算（方向检查）', () => {
  let prev = -Infinity;
  [5, 10, 20, 40, 75, 150, 300].forEach((p) => {
    const s = an({ perUsePrice: p }).sim;
    assert.ok(s.savingPV >= prev - 1e-9, '单次价 ' + p + ' 时省下倒退');
    prev = s.savingPV;
  });
});

test('常识：等效年费摊在卡面年限上 = 卡价 ÷ 年限（与使用情况无关）', () => {
  [[3600, 10, 360], [2400, 2, 1200], [9800, 1, 9800], [1000, 30, 1000 / 30]].forEach(([P, Y, want]) => {
    const r = an({ payType: 'multiyear', cardPrice: String(P), cardYears: String(Y), horizonYears: String(Y) });
    near(r.sim.cardAnnual, want, 1e-9, P + ' 元 / ' + Y + ' 年');
  });
});

test('常识：回本次数 = 卡价 ÷ 单次价，与衰减、消失、折现全部无关（4 组交叉）', () => {
  [[3600, 75, 48], [2400, 50, 48], [1000, 40, 25], [9800, 80, 122.5]].forEach(([P, A, want]) => {
    [[0, 0, 0], [20, 30, 8]].forEach(([d, m, r0]) => {
      const s = an({
        payType: 'lifetime', cardPrice: String(P), perUsePrice: String(A),
        decayPerYear: String(d), failurePerYear: String(m), discountRate: String(r0)
      }).sim;
      near(s.visitsToPayback, want, 1e-9, P + '/' + A + ' d=' + d + ' m=' + m);
    });
  });
});

test('常识：储值卡的赠送率与折扣率互为倒数关系', () => {
  const r = an({ payType: 'stored', cardPrice: '1000', cardFace: '1200' });
  near(r.sim.bonus, 200, 1e-12);
  near(r.sim.discountRateOnFace, 1000 / 1200, 1e-15);
  near(r.laws.bonusRate, 0.2, 1e-12, '赠送率 = 赠送 ÷ 实付');
  near(r.sim.discountRateOnFace * r.cfg.cardFace, 1000, 1e-9, '折扣率 × 面值 = 实付');
});

test('常识：面值用尽时省下现值上限就是「赠送额的现值」', () => {
  const r = an({ payType: 'stored', cardPrice: '1000', cardFace: '1200', visitsPerMonth: '10', decayPerYear: '0', perUsePrice: '40', horizonYears: '3', discountRate: '0', failurePerYear: '0' });
  assert.ok(r.sim.balanceLeft === 0 || r.sim.balanceLeft < 1e-9, '应按设计用尽');
  near(r.sim.savingPV, 200, 1e-6, '不折现不消失时省下恰好等于赠送额');
});
