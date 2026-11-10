/* 长期卡对账台 · 界面（lifetime-ledger）
 * 依赖 window.AppCore（core.js）。所有展示数字都来自同一次 analyze() 的结果。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'lifetime-ledger:v1';

  const state = { res: null, checks: [], errors: [], warnings: [], sel: 0, exportCount: 0, renders: 0 };

  /* ── 格式化 ───────────────────────────────────────── */
  const M2 = (x) => C.fmtMoney(x);              // 金额，两位
  const M0 = (x) => C.fmtMoney0(x);             // 金额，整数
  /* 三档自适应：>= 1000 取整；>= 0.01 两位小数；再小就给有效数字，
     避免「< 0.01」这种看不出量级的显示（极限测试档实测出现过） */
  const M1 = (x) => C.fmtMoneyAdaptive(x);
  const P2 = (x) => C.fmtPct(x, 2);
  const T2 = (x) => C.fmtTimes(x, 2);
  const YR = (x) => C.fmtYears(x);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PILL = { win: 'ok', flat: 'tight', loss: 'fail' };
  const pillHTML = (v) => '<span class="pill ' + (PILL[v.id] || 'tight') + '">' + esc(v.label) + '</span>';
  const TYPE_NAME = { lifetime: '终身 / 买断', multiyear: '多年卡', stored: '储值卡' };

  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;background:#161b22;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:99;opacity:0;transition:opacity .18s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; }, 1900);
  }

  /* ── 表单 ─────────────────────────────────────────── */
  function fillSelects() {
    $('payType').innerHTML = C.PAY_TYPES.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + '</option>';
    }).join('');
    $('scenario').innerHTML = '<option value="">（选择场景）</option>' + C.scenarios.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
    }).join('');
  }

  function readInput() {
    return {
      payType: $('payType').value,
      cardPrice: $('cardPrice').value,
      cardFace: $('cardFace').value,
      cardYears: $('cardYears').value,
      visitsPerMonth: $('visitsPerMonth').value,
      decayPerYear: $('decayPerYear').value,
      perUsePrice: $('perUsePrice').value,
      horizonYears: $('horizonYears').value,
      discountRate: $('discountRate').value,
      failurePerYear: $('failurePerYear').value
    };
  }

  function writeInput(inp) {
    const d = C.defaults();
    const keys = ['payType', 'cardPrice', 'cardFace', 'cardYears', 'visitsPerMonth', 'decayPerYear', 'perUsePrice', 'horizonYears', 'discountRate', 'failurePerYear'];
    keys.forEach(function (k) {
      if (!$(k)) return;
      const v = inp && inp[k] !== undefined && inp[k] !== null ? inp[k] : d[k];
      $(k).value = String(v);
    });
    if (inp && Array.isArray(inp.items)) state.items = inp.items; else state.items = null;
    toggleCond();
  }

  function toggleCond() {
    const t = $('payType').value;
    $('wrapFace').classList.toggle('hidden', t !== 'stored');
    $('wrapYears').classList.toggle('hidden', t !== 'multiyear');
    const hint = C.PAY_TYPES.filter(function (x) { return x.id === t; })[0];
    $('payTypeHint').textContent = hint ? hint.hint : '';
    const p = C.parseNum($('cardPrice').value);
    const f = C.parseNum($('cardFace').value);
    if (t === 'stored' && isFinite(p) && isFinite(f)) {
      if (f < p) $('priceHint').textContent = '到手面值比实付还小 —— 这不成立，请检查（赠送只能是正的）。';
      else if (f > p) $('priceHint').textContent = '赠送 ' + M2(f - p) + ' 元，相当于按面值消费时 ' + P2(1 - p / f) + ' 的折扣。';
      else $('priceHint').textContent = '面值 = 实付，没有赠送：这张卡只是「先交钱」，后面按面值消费。';
    } else if (t === 'multiyear') {
      const y = C.parseNum($('cardYears').value);
      $('priceHint').textContent = isFinite(p) && isFinite(y) && y > 0
        ? '摊到卡面年限上是 ' + M2(p / y) + ' 元/年（这是「卡面年费」口径，不考虑你去不去）。' : '';
    } else if (t === 'lifetime') {
      $('priceHint').textContent = isFinite(p) ? '终身卡没有到期日：实付 ' + M2(p) + ' 元一次性付清，之后每次不再单独掏钱。' : '';
    } else {
      $('priceHint').textContent = '';
    }
  }

  function markBad(errors) {
    Array.prototype.forEach.call(document.querySelectorAll('input.bad, select.bad'), function (el) { el.classList.remove('bad'); });
    const shown = [];
    errors.forEach(function (e) {
      const id = String(e.field || '').replace(/^\./, '');
      if (id && $(id)) { $(id).classList.add('bad'); }
      shown.push(e.msg);
    });
    $('errors').innerHTML = shown.length
      ? '<div class="errbox"><b>先修好这些再算：</b><ul class="tight">' + shown.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>'
      : '';
    return shown;
  }

  /* ── 计算与渲染 ───────────────────────────────────── */
  function compute() {
    const raw = readInput();
    if (state.items) raw.items = state.items;
    const res = C.analyze(raw);
    state.renders++;
    if (!res.ok) {
      state.res = null;
      markBad(res.errors);
      ['headline', 'kpis', 'compare', 'yearBody', 'laws', 'insights', 'cardBody', 'detailBody', 'sensBody', 'steps', 'checks', 'warnBox'].forEach(function (id) {
        if ($(id)) $(id).innerHTML = '';
      });
      $('verdictTag').textContent = '输入未通过校验';
      $('checkTag').textContent = '';
      $('detailName').textContent = '';
      $('sensOf').textContent = '';
      return res;
    }
    markBad([]);
    state.res = res;
    state.checks = res.checks;
    render(res);
    return res;
  }

  function render(res) {
    const s = res.sim;
    $('verdictTag').innerHTML = pillHTML(res.verdict);

    /* 结论 */
    const saved = s.savingPV;
    const head = [];
    head.push('按你填的这组假设：<b>买卡' + (saved > 0 ? '划算' : (Math.abs(saved) < 0.005 ? '基本打平' : '不划算')) + '</b>——' +
      '全程按次付要花 <b>' + M2(s.costNoCard) + '</b> 元（现值），买卡是 <b>' + M2(s.costWithCard) + '</b> 元（现值），差 <b' +
      (saved > 0 ? ' class="vd"' : ' class="vf"') + '>' + (saved > 0 ? '省 ' : '多花 ') + M2(Math.abs(saved)) + '</b> 元。');
    if (s.breakevenPerMonth === null || !isFinite(s.breakevenPerMonth)) {
      head.push('哪怕每月去 ' + C.VISITS_PER_MONTH_MAX + ' 次（每年 ' + M0(C.VISITS_PER_MONTH_MAX * 12) + ' 次），折扣累计也追不上卡价。');
    } else {
      head.push('盈亏平衡在第 1 年每月 <b>' + T2(s.breakevenPerMonth) + ' 次</b>（你填的是每月 ' + T2(res.cfg.visitsPerMonth) + ' 次）。');
    }
    if (s.paybackYears === Infinity) head.push('按这组假设<b>永远回不了本</b>。');
    else head.push('折扣累计追平卡价在第 <b>' + YR(s.paybackYears) + '</b> 年（共需 ' + T2(s.visitsToPayback) + ' 次到访）。');
    $('headline').innerHTML = head.join(' ');

    /* KPI */
    const kpi = [
      ['卡价 ÷ 单次价', T2(s.visitsToPayback) + ' 次', '就是「折扣累计追平卡价」要去的次数'],
      ['盈亏平衡频率', s.breakevenPerMonth === null ? '—' : (isFinite(s.breakevenPerMonth) ? T2(s.breakevenPerMonth) + ' 次/月' : '做不到'), '每月第 1 年至少去这么多次才划算'],
      ['卡面年费', M2(s.cardAnnual) + '/年', '实付 ÷ 卡面年限，不考虑你去不去'],
      ['摊到次数上的成本', M2(res.laws.costPerVisit) + '/次', '实付 ÷ 累计期望到访 ' + T2(s.cumVisits) + ' 次；按次付是 ' + M2(res.cfg.perUsePrice) + '/次']
    ];
    $('kpis').innerHTML = kpi.map(function (k) {
      return '<div class="kpi"><div class="k">' + esc(k[0]) + '</div><div class="v">' + esc(k[1]) + '</div><div class="s">' + esc(k[2]) + '</div></div>';
    }).join('');

    /* 提醒 */
    const warn = [];
    if (res.isStored && res.laws.bonusRate > 1) warn.push('到手面值是实付的 ' + C.fmtTimes(res.cfg.cardFace / res.cfg.cardPrice, 1) + ' 倍 —— 赠送率超过 100% 在现实里基本不存在，这组数只用来试边界。');
    if (res.cfg.failurePerYear >= 10) warn.push('你填的年消失概率是 ' + P2(res.cfg.failurePerYear / 100) + ' —— 这已经很高：' + M2(s.costNoCard - s.costWithCard) + ' 元的「省下」里有很大一块取决于店还开着。');
    if (res.isStored && s.balanceLeft > 0) warn.push('按这组假设，期末还剩 <b>' + M2(s.balanceLeft) + '</b> 元面值没用完（占面值 ' + P2(s.faceLeftRatio) + '）——这是先垫出去、还没换成服务的钱。');
    if (res.cfg.payType === 'multiyear' && s.expireYear) warn.push('卡面年限只有 ' + res.cfg.cardYears + ' 年：第 ' + s.expireYear + ' 年起这张卡不再产生折扣，而你要看 ' + res.cfg.horizonYears + ' 年。');
    if (res.cfg.decayPerYear >= 30) warn.push('年到访衰减率 ' + P2(res.cfg.decayPerYear / 100) + ' 意味着第 5 年的到访只剩第 1 年的 ' + P2(Math.pow(1 - res.cfg.decayPerYear / 100, 4)) + ' ——衰减是这类卡最常见的亏损来源。');
    $('warnBox').innerHTML = warn.length ? '<div class="warnbox">' + warn.join('<br>') + '</div>' : '';

    renderCompare(res);
    renderYears(res);
    renderLaws(res);
    renderInsights(res);
    renderCards(res);
    renderDetail(res);
    renderSens(res);
    renderSteps(res);
    renderLimits();
    renderChecks(res);
  }

  /* 两种付法对账 */
  function renderCompare(res) {
    const s = res.sim, cfg = res.cfg;
    const rows = [
      ['一次实付（第 1 年就掏出去）', M2(cfg.cardPrice), '在第 0 年折现，就是它本身'],
      ['卡面能抵掉的按次价', M2(s.cumFaceRedeemed), '按面值抵扣的名义金额（不折现；已按「店还开着」的概率打折）'],
      ['抵扣不够时自己补的部分', M2(s.cumSelfPay), '余额用完 / 卡到期之后，还是要按单次价付'],
      ['<b>买卡这条路：合计现值</b>', '<b>' + M2(s.costWithCard) + '</b>', '= 一次实付 + 自付部分的现值 ' + M2(s.selfPayPV)],
      ['<b>全程按次付：合计现值</b>', '<b>' + M2(s.costNoCard) + '</b>', '同一份到访，一次都不买卡，按单次价付到底'],
      ['<b>差（正 = 买卡更省）</b>', '<b class="' + (s.savingPV > 0 ? 'vd' : 'vf') + '">' + (s.savingPV > 0 ? '省 ' : '多花 ') + M2(Math.abs(s.savingPV)) + '</b>', '= 按次付现值 − 买卡现值，结论就取这个数']
    ];
    $('compare').innerHTML = '<div class="tw"><table class="wrap" style="width:100%"><tbody>' + rows.map(function (r) {
      return '<tr><td style="width:46%">' + r[0] + '</td><td style="width:18%;font-weight:600">' + r[1] + '</td><td style="width:36%;white-space:normal;color:var(--ink3);font-size:12px">' + esc(r[2]) + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
      '<p class="footnote">不折现的粗口径也一并给出，方便和直觉对照：不折现时按次付 ' + M2(s.costNoCardUndisc) + ' 元、买卡 ' + M2(cfg.cardPrice + s.cumSelfPay) + ' 元，差 ' +
      M2(s.savingUndisc) + ' 元。' + ((s.savingUndisc >= 0) !== (s.savingPV >= 0)
        ? '<b>两个口径方向不同</b>：钱是先掏的、好处是后面逐年才拿到的，所以折现之后可能就不划算了 —— 这本身就是结论的一部分。' : '') + '</p>';
  }

  /* 逐年一本账 */
  function renderYears(res) {
    const s = res.sim;
    $('yearBody').innerHTML = res.rows.map(function (r) {
      const vd = r.net >= 0 ? 'vd' : 'vf';
      return '<tr>' +
        '<td>第 ' + r.year + ' 年' + (r.expired ? ' <span class="muted">（卡已到期）</span>' : '') + '</td>' +
        '<td>' + P2(r.survive) + '</td>' +
        '<td>' + T2(r.visits) + '</td>' +
        '<td>' + T2(r.expectedVisits) + '</td>' +
        '<td>' + M2(r.valueGross) + '</td>' +
        '<td>' + M2(r.cumValue) + '</td>' +
        '<td>' + M2(r.cumValuePV) + '</td>' +
        '<td class="' + vd + '">' + M2(r.net) + '</td>' +
        '<td>' + (r.balanceLeft === null ? '—' : M0(r.balanceLeft)) + '</td>' +
        '</tr>';
    }).join('') +
      '<tr class="sum"><td>合计</td><td>—</td><td>—</td><td>' + T2(s.cumVisits) + '</td>' +
      '<td>' + M2(s.cumValue) + '</td><td>' + M2(s.cumValue) + '</td><td>' + M2(s.cumValuePV) + '</td>' +
      '<td class="' + (s.net >= 0 ? 'vd' : 'vf') + '">' + M2(s.net) + '</td><td>—</td></tr>';
  }

  /* 口径对照 */
  function renderLaws(res) {
    const s = res.sim, cfg = res.cfg, L = res.laws;
    const items = [
      ['「店还开着」的概率是逐年连乘的',
        '第 t 年还开着的概率 = (1 − ' + P2(cfg.failurePerYear / 100) + ')^t，所以第 ' + cfg.horizonYears + ' 年是 ' + P2(res.rows[res.rows.length - 1].survive) +
        '。本页用的有效年数之和是 <b>' + T2(s.cumDecayVisits / (cfg.visitsPerMonth * 12)) + '</b> 年（= Σ 存活概率），而不是「店平均能活几年」——这两个数不一样。'],
      ['回本需要的次数与衰减、消失、折现都无关',
        '回本只看「累计折扣」追上「一次实付」：需要 <b>' + T2(s.visitsToPayback) + '</b> 次（' + M0(cfg.cardPrice) + ' ÷ ' + M2(cfg.perUsePrice) + '）。但「多久能凑够这些次数」完全取决于衰减与消失。'],
      ['等效年费有三个口径，回答的不是同一个问题',
        '摊到卡面 ' + cfg.cardYears + ' 年：<b>' + M1(L.eqByFace) + '/年</b>；摊到「卡还有效的年数」' + s.usedYears + ' 年：<b>' + M1(L.eqByUsed) + '/年</b>；摊到累计期望 ' + T2(s.cumVisits) + ' 次上：<b>' + M1(L.costPerVisit) + '/次</b>。'],
      ['这套假设下这张卡的「折扣价值」是 ' + M2(s.cumValue) + ' 元',
        '= 累计期望到访 ' + T2(s.cumVisits) + ' 次 × ' + M2(cfg.perUsePrice) + ' 元' + (res.isStored ? '（储值卡封顶到面值，实际兑现 ' + M2(s.cumFaceRedeemed) + ' 元面值 × 折扣率 ' + C.fmtPct(Math.max(0, s.discountRateOnFace), 4) + '）' : '') + '。']
    ];
    if (res.isStored) {
      items.push(['储值卡先看赠送，再看用不用得完',
        '实付 ' + M0(cfg.cardPrice) + ' 拿到面值 ' + M0(cfg.cardFace) + '，赠送 <b>' + M2(s.bonus) + '</b>（+' + P2(L.bonusRate) + '），按面值消费相当于 ' + P2(1 - s.discountRateOnFace) + ' 的折扣。' +
        (s.exhaustYear ? '按这组频率第 <b>' + s.exhaustYear + '</b> 年用尽（含当年零头）。' : '按这组频率 ' + cfg.horizonYears + ' 年内用不完，期末还余 ' + M2(s.balanceLeft) + ' 元面值。')]);
    }
    $('laws').innerHTML = '<div class="grid3">' + items.map(function (x) {
      return '<div class="metric"><div class="mk" style="font-weight:700;color:var(--ink)">' + esc(x[0]) + '</div><div class="ms" style="font-size:12.5px;line-height:1.6;margin-top:4px">' + x[1] + '</div></div>';
    }).join('') + '</div>';
  }

  /* 要点（核心生成的同一次结果） */
  function renderInsights(res) {
    $('insights').innerHTML = res.insights.map(function (x) {
      return '<div class="slice"><span class="st">' + esc(x.t) + '</span>' + x.d + '</div>';
    }).join('');
  }

  /* 卡清单 */
  function renderCards(res) {
    if (!res.items || !res.items.length) {
      $('cardBody').innerHTML = '<tr><td colspan="11" class="muted">这份输入里没有卡清单。</td></tr>';
      $('detailName').textContent = '';
      $('detailBody').innerHTML = '';
      return;
    }
    if (state.sel >= res.items.length) state.sel = 0;
    $('cardBody').innerHTML = res.items.map(function (it, i) {
      if (!it.ok) {
        return '<tr><td>' + esc(it.name) + '</td><td colspan="10" class="vf">这张卡的输入有错：' +
          esc(it.errors.map(function (e) { return e.msg; }).join('；')) + '</td></tr>';
      }
      const sim = it.sim;
      return '<tr class="pick' + (i === state.sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<td>' + esc(it.name) + '</td>' +
        '<td>' + esc(TYPE_NAME[it.cfg.payType] || it.cfg.payType) + '</td>' +
        '<td>' + M2(it.cfg.cardPrice) + '</td>' +
        '<td>' + M2(it.cfg.cardFace) + '</td>' +
        '<td>' + T2(it.cfg.visitsPerMonth) + '</td>' +
        '<td>' + M2(it.cfg.perUsePrice) + '</td>' +
        '<td>' + M2(sim.costNoCard) + '</td>' +
        '<td>' + M2(sim.costWithCard) + '</td>' +
        '<td class="' + (sim.savingPV >= 0 ? 'vd' : 'vf') + '">' + M2(sim.savingPV) + '</td>' +
        '<td>' + (sim.breakevenPerMonth === null ? '—' : (isFinite(sim.breakevenPerMonth) ? T2(sim.breakevenPerMonth) + '/月' : '做不到')) + '</td>' +
        '<td>' + pillHTML(it.verdict) + '</td>' +
        '</tr>';
    }).join('');
  }

  /* 选中卡详解 */
  function renderDetail(res) {
    if (!res.items || !res.items.length) return;
    const it = res.items[state.sel];
    if (!it || !it.ok) { $('detailName').textContent = ''; $('detailBody').innerHTML = ''; return; }
    $('detailName').textContent = it.name;
    const s = it.sim, c = it.cfg;
    const rows = [
      ['类型', TYPE_NAME[c.payType] || c.payType],
      ['一次实付 / 到手面值', M2(c.cardPrice) + ' / ' + M2(c.cardFace) + (c.payType === 'stored' && s.bonus > 0 ? '（赠送 ' + M2(s.bonus) + '）' : '')],
      ['卡面年限 / 向前看', c.cardYears + ' 年 / ' + c.horizonYears + ' 年' + (s.expireYear ? '（第 ' + s.expireYear + ' 年起卡失效）' : '')],
      ['每月次数 / 年到访衰减 / 年消失', T2(c.visitsPerMonth) + ' 次 / ' + P2(c.decayPerYear / 100) + ' / ' + P2(c.failurePerYear / 100)],
      ['单次价 / 年折现率', M2(c.perUsePrice) + ' / ' + P2(c.discountRate / 100)],
      ['累计期望到访', T2(s.cumVisits) + ' 次'],
      ['折扣价值（不折现）', M2(s.cumValue)],
      ['按次付现值 / 买卡现值', M2(s.costNoCard) + ' / ' + M2(s.costWithCard)],
      ['省下现值', '<b class="' + (s.savingPV >= 0 ? 'vd' : 'vf') + '">' + M2(s.savingPV) + '</b>'],
      ['回本所需次数 / 回本年份', T2(s.visitsToPayback) + ' 次 / ' + YR(s.paybackYears) + ' 年'],
      ['盈亏平衡频率', s.breakevenPerMonth === null ? '—' : (isFinite(s.breakevenPerMonth) ? T2(s.breakevenPerMonth) + ' 次/月' : '即使天天去也做不到')],
      ['卡面年费 / 有效期年数', M1(s.cardAnnual) + '/年 / ' + s.usedYears + ' 年'],
      ['等效年费（摊到有效期）', M1(s.equivalentAnnual) + '/年'],
      ['实付摊到次数上', M1(C.lawsOf(c, s).costPerVisit) + '/次（按次付是 ' + M2(c.perUsePrice) + '/次）'],
      ['判定', pillHTML(it.verdict) + ' <span class="muted">（省下现值 ' + M2(s.savingPV) + '，卡价的 25% 是分档线）</span>']
    ];
    if (c.payType === 'stored') {
      rows.push(['面值用尽 / 期末余额', (s.exhaustYear ? '第 ' + s.exhaustYear + ' 年用尽（含当年零头）' : '观察期内没用完') + ' / ' + M2(s.balanceLeft) + '（占面值 ' + P2(s.faceLeftRatio) + '）']);
      const lawsIt = C.lawsOf(c, s);
      rows.push(['赠送率 / 按面值折扣', P2(lawsIt.bonusRate) + ' / ' + P2(1 - s.discountRateOnFace)]);
    }
    /* 选中卡的自检：清单条目本身不带 checks，这里按需为这一张单独跑一遍结构自检 */
    const itChecks = C.verify({ cfg: c, sim: s, rows: s.rows });
    const itPass = itChecks.filter(function (x) { return x.pass; }).length;
    $('detailBody').innerHTML = '<div class="tw"><table class="wrap" style="width:100%"><tbody>' + rows.map(function (r) {
      return '<tr><td style="width:40%">' + esc(r[0]) + '</td><td style="white-space:normal">' + r[1] + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
      '<p class="footnote">这张卡的自检：' + itPass + '/' + itChecks.length + ' 通过' +
      (itPass < itChecks.length ? '（<span class="vf">有未通过项：' +
        esc(itChecks.filter(function (x) { return !x.pass; }).map(function (x) { return x.name; }).join('；')) + '</span>）' : '') + '。</p>';
  }

  /* 敏感性 */
  function renderSens(res) {
    $('sensOf').textContent = '对主卡（不是清单）';
    $('sensBody').innerHTML = res.sens.map(function (r) {
      const d = r.deltaPV;
      const cls = Math.abs(d) < 0.005 ? '' : (d > 0 ? 'vd' : 'vf');
      return '<tr>' +
        '<td>' + esc(r.label) + '</td>' +
        '<td>' + M2(r.cumValue) + '</td>' +
        '<td>' + M2(r.costNoCard) + '</td>' +
        '<td>' + M2(r.costWithCard) + '</td>' +
        '<td>' + M2(r.savingPV) + '</td>' +
        '<td class="' + cls + '">' + (Math.abs(d) < 0.005 ? '0.00' : (d > 0 ? '+' : '−') + M2(Math.abs(d))) + '</td>' +
        '<td>' + (r.breakevenPerMonth === null ? '—' : (isFinite(r.breakevenPerMonth) ? T2(r.breakevenPerMonth) + '/月' : '做不到')) + '</td>' +
        '<td>' + pillHTML(r.verdict) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderSteps(res) {
    const s = res.sim, cfg = res.cfg, out = [];
    if (s.savingPV < 0) {
      out.push('按这组假设<b>别买</b>：全程按次付比买卡省 ' + M2(-s.savingPV) + ' 元（现值）。要买的话，第 1 年每月至少要 ' +
        (isFinite(s.breakevenPerMonth) ? T2(s.breakevenPerMonth) + ' 次' : '做不到') + '。');
    } else {
      out.push('按这组假设<b>可以买</b>：比全程按次付省 ' + M2(s.savingPV) + ' 元（现值）。');
    }
    if (isFinite(s.breakevenPerMonth) && cfg.visitsPerMonth < s.breakevenPerMonth) {
      out.push('你填的频率差平衡点 ' + T2(s.breakevenPerMonth - cfg.visitsPerMonth) + ' 次/月 —— 回到上面的「第 1 年每月去几次」把它调到 ' + T2(s.breakevenPerMonth) + ' 次，看结论会不会翻。');
    }
    if (res.isStored && s.balanceLeft > 0) {
      out.push('期末还剩 ' + M2(s.balanceLeft) + ' 元面值没用完。把「年到访衰减率」调低或「向前看几年」调长，看这块钱能不能被用掉。');
    }
    if (cfg.payType === 'multiyear' && s.expireYear && cfg.horizonYears > cfg.cardYears) {
      out.push('卡面 ' + cfg.cardYears + ' 年、你要看 ' + cfg.horizonYears + ' 年：第 ' + s.expireYear + ' 年之后的到访要按单次价另算，那段已经在「买卡现值」里的自付部分计过了。');
    }
    if (cfg.failurePerYear > 0) {
      out.push('把「店 / 商家年消失概率」改成 0（当作永远不会没）再算一次，两次的差额就是你为「它可能会没」付的价钱：' +
        M2(res.sens.filter(function (x) { return x.label.indexOf('消失概率归零') >= 0; })[0].deltaPV) + ' 元。');
    }
    out.push('把「年折现率」改成 0，能看出「不折现」口径下的结论 —— 两个口径方向不同时，说明结论对「先掏钱」这件事很敏感。');
    out.push('这四个假设里，最值得你自己去确认的是<b>到访频率</b>与<b>年到访衰减率</b>：前者有记录可查（付款记录、打卡记录），后者只能自己估。');
    $('steps').innerHTML = out.map(function (t) { return '<li>' + t + '</li>'; }).join('');
  }

  function renderLimits() {
    $('limits').innerHTML = C.LIMITS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }

  function renderChecks(res) {
    const pass = res.checks.filter(function (c) { return c.pass; }).length;
    $('checkTag').textContent = pass + ' / ' + res.checks.length + ' 通过';
    $('checks').innerHTML = res.checks.map(function (c) {
      return '<li>' + (c.pass ? '<span class="vd">✔</span> ' : '<span class="vf">✘</span> ') + esc(c.name) +
        ' <span class="muted">— ' + esc(c.detail) + '</span></li>';
    }).join('');
  }

  /* ── 导出 ─────────────────────────────────────────── */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    state.exportCount++;
  }

  function csvText() {
    const res = state.res; if (!res) return '';
    const s = res.sim, cfg = res.cfg;
    const cell = function (x) { const t = String(x); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const L = [];
    L.push(['长期卡对账台', '导出时间', new Date().toISOString()].map(cell).join(','));
    L.push(['说明', '默认样例与内置场景均为虚构示例；所有数字来自同一次 analyze()'].map(cell).join(','));
    L.push('');
    L.push(['输入', '值'].map(cell).join(','));
    [['卡的类型', TYPE_NAME[cfg.payType]], ['一次实付（元）', cfg.cardPrice], ['到手面值（元）', cfg.cardFace],
      ['卡面年限（年）', cfg.cardYears], ['第 1 年每月次数', cfg.visitsPerMonth], ['年到访衰减率（%）', cfg.decayPerYear],
      ['不用卡单次价（元）', cfg.perUsePrice], ['向前看几年', cfg.horizonYears], ['年折现率（%）', cfg.discountRate],
      ['店年消失概率（%）', cfg.failurePerYear]].forEach(function (r) { L.push([r[0], r[1]].map(cell).join(',')); });
    L.push('');
    L.push(['结果', '值'].map(cell).join(','));
    [['判定', res.verdict.label], ['省下现值（元）', s.savingPV], ['全程按次付现值（元）', s.costNoCard], ['买卡现值（元）', s.costWithCard],
      ['一次实付（元）', cfg.cardPrice], ['自付部分现值（元）', s.selfPayPV], ['卡面抵扣的按次价（元）', s.cumFaceRedeemed],
      ['累计期望到访（次）', s.cumVisits], ['折扣价值（元）', s.cumValue], ['折扣价值现值（元）', s.cumValuePV],
      ['回本所需次数', s.visitsToPayback], ['回本年份', s.paybackYears], ['盈亏平衡频率（次/月）', s.breakevenPerMonth],
      ['卡面年费（元/年）', s.cardAnnual], ['摊到次数（元/次）', res.laws.costPerVisit],
      ['期末余额（元）', s.balanceLeft], ['用尽年份', s.exhaustYear]].forEach(function (r) { L.push([r[0], r[1]].map(cell).join(',')); });
    L.push('');
    L.push(['逐年', '店还开着', '这一年去几次', '期望到访', '当年折扣', '累计折扣', '累计现值', '累计净值', '余额'].map(cell).join(','));
    res.rows.forEach(function (r) {
      L.push([r.year, r.survive, r.visits, r.expectedVisits, r.valueGross, r.cumValue, r.cumValuePV, r.net,
        r.balanceLeft === null ? '' : r.balanceLeft].map(cell).join(','));
    });
    L.push('');
    L.push(['结构自检', '结果', '细节'].map(cell).join(','));
    res.checks.forEach(function (c) { L.push([c.name, c.pass ? 'PASS' : 'FAIL', c.detail].map(cell).join(',')); });
    if (res.items && res.items.length) {
      L.push('');
      L.push(['卡清单', '类型', '实付', '面值', '每月次数', '单次价', '按次付现值', '买卡现值', '省下现值', '平衡频率', '判定'].map(cell).join(','));
      res.items.forEach(function (it) {
        if (!it.ok) { L.push([it.name, '输入有误'].map(cell).join(',')); return; }
        L.push([it.name, TYPE_NAME[it.cfg.payType], it.cfg.cardPrice, it.cfg.cardFace, it.cfg.visitsPerMonth, it.cfg.perUsePrice,
          it.sim.costNoCard, it.sim.costWithCard, it.sim.savingPV, it.sim.breakevenPerMonth, it.verdict.label].map(cell).join(','));
      });
    }
    return '\ufeff' + L.join('\n');
  }

  function mdText() {
    const res = state.res; if (!res) return '';
    const s = res.sim, cfg = res.cfg, L = [];
    L.push('# 长期卡对账台 · 结果');
    L.push('');
    L.push('- 导出时间：' + new Date().toISOString());
    L.push('- 说明：默认样例与内置场景均为虚构示例；所有数字来自同一次 `analyze()`');
    L.push('');
    L.push('## 结论');
    L.push('');
    L.push('**' + res.verdict.label + '**：全程按次付现值 ' + M2(s.costNoCard) + ' 元 vs 买卡现值 ' + M2(s.costWithCard) + ' 元，差 ' + M2(s.savingPV) + ' 元（正 = 买卡更省）。');
    L.push('');
    L.push('| 指标 | 值 |');
    L.push('|---|---|');
    [['一次实付', M2(cfg.cardPrice)], ['到手面值', M2(cfg.cardFace)], ['卡面年限', cfg.cardYears + ' 年'],
      ['第 1 年每月次数', T2(cfg.visitsPerMonth)], ['年到访衰减率', P2(cfg.decayPerYear / 100)], ['不用卡单次价', M2(cfg.perUsePrice)],
      ['向前看', cfg.horizonYears + ' 年'], ['年折现率', P2(cfg.discountRate / 100)], ['店年消失概率', P2(cfg.failurePerYear / 100)],
      ['累计期望到访', T2(s.cumVisits) + ' 次'], ['折扣价值（不折现）', M2(s.cumValue)], ['折扣价值现值', M2(s.cumValuePV)],
      ['回本所需次数', T2(s.visitsToPayback) + ' 次'], ['回本年份', YR(s.paybackYears) + ' 年'],
      ['盈亏平衡频率', (s.breakevenPerMonth === null ? '—' : T2(s.breakevenPerMonth) + ' 次/月')],
      ['卡面年费', M1(s.cardAnnual) + '/年'], ['卡还有效的年数', s.usedYears + ' 年'],
      ['等效年费（摊到有效期）', M1(s.equivalentAnnual) + '/年'],
      ['实付摊到次数上', M1(res.laws.costPerVisit) + '/次'],
      ['期末余额', M2(s.balanceLeft)], ['用尽年份', s.exhaustYear === null ? '—' : '第 ' + s.exhaustYear + ' 年']].forEach(function (r) {
      L.push('| ' + r[0] + ' | ' + r[1] + ' |');
    });
    L.push('');
    L.push('## 逐年一本账');
    L.push('');
    L.push('| 第几年 | 店还开着 | 这一年去几次 | 期望到访 | 当年折扣 | 累计折扣 | 累计现值 | 累计净值 | 余额 |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    res.rows.forEach(function (r) {
      L.push('| 第 ' + r.year + ' 年 | ' + P2(r.survive) + ' | ' + T2(r.visits) + ' | ' + T2(r.expectedVisits) + ' | ' +
        M2(r.valueGross) + ' | ' + M2(r.cumValue) + ' | ' + M2(r.cumValuePV) + ' | ' + M2(r.net) + ' | ' +
        (r.balanceLeft === null ? '—' : M0(r.balanceLeft)) + ' |');
    });
    L.push('');
    L.push('## 要点');
    L.push('');
    res.insights.forEach(function (x) { L.push('- **' + x.t + '** ' + x.d); });
    L.push('');
    L.push('## 卡清单');
    L.push('');
    if (res.items && res.items.length) {
      L.push('| 卡 | 类型 | 实付 | 面值 | 每月次数 | 单次价 | 按次付现值 | 买卡现值 | 省下现值 | 平衡频率 | 判定 |');
      L.push('|---|---|---|---|---|---|---|---|---|---|---|');
      res.items.forEach(function (it) {
        if (!it.ok) { L.push('| ' + it.name + ' | 输入有误 | | | | | | | | | |'); return; }
        L.push('| ' + it.name + ' | ' + TYPE_NAME[it.cfg.payType] + ' | ' + M2(it.cfg.cardPrice) + ' | ' + M2(it.cfg.cardFace) + ' | ' +
          T2(it.cfg.visitsPerMonth) + ' | ' + M2(it.cfg.perUsePrice) + ' | ' + M2(it.sim.costNoCard) + ' | ' + M2(it.sim.costWithCard) + ' | ' +
          M2(it.sim.savingPV) + ' | ' + (it.sim.breakevenPerMonth === null ? '—' : T2(it.sim.breakevenPerMonth) + '/月') + ' | ' + it.verdict.label + ' |');
      });
    } else {
      L.push('（无）');
    }
    L.push('');
    L.push('## 敏感性（每行都完整重算）');
    L.push('');
    L.push('| 改动 | 累计折扣 | 按次付现值 | 买卡现值 | 省下现值 | 变化 | 平衡频率 | 判定 |');
    L.push('|---|---|---|---|---|---|---|---|');
    res.sens.forEach(function (r) {
      L.push('| ' + r.label + ' | ' + M2(r.cumValue) + ' | ' + M2(r.costNoCard) + ' | ' + M2(r.costWithCard) + ' | ' + M2(r.savingPV) + ' | ' +
        M2(r.deltaPV) + ' | ' + (r.breakevenPerMonth === null ? '—' : T2(r.breakevenPerMonth) + '/月') + ' | ' + r.verdict.label + ' |');
    });
    L.push('');
    L.push('## 结构自检');
    L.push('');
    res.checks.forEach(function (c) { L.push('- [' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.name + ' — ' + c.detail); });
    L.push('');
    L.push('## 这份账不算什么');
    L.push('');
    C.LIMITS.forEach(function (t) { L.push('- ' + t); });
    return L.join('\n');
  }

  function jsonBackup() {
    return JSON.stringify({
      app: 'lifetime-ledger', version: 1, savedAt: new Date().toISOString(),
      input: readInput(), items: state.items || undefined
    }, null, 2);
  }

  /* ── 结果卡 PNG（1080×1350） ──────────────────────── */
  function pngCard() {
    const res = state.res; if (!res) { toast('先让输入通过校验'); return; }
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const FONT = function (w2, sz) { return w2 + ' ' + sz + 'px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'; };
    /* 空白必须作为独立 token 保留，否则整张卡的数字之间的空格会被静默吃掉 */
    const toks = function (t) { return String(t).match(/[A-Za-z0-9.,%×÷+\-−/（）()]+|\s+|[\u4e00-\u9fa5]|[^\s]/g) || []; };
    const wrap = function (text, maxW, size, weight) {
      g.font = FONT(weight || 400, size);
      const out = [];
      let line = '';
      toks(text).forEach(function (t) {
        const t2 = line + t;
        if (g.measureText(t2).width > maxW && line.trim()) {
          out.push(line.replace(/\s+$/, ''));
          line = t.replace(/^\s+/, '');
        } else line = t2;
      });
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
      return out.map(function (x, i) { return (i > 0 && /^[）)；，。、%》]/.test(x)) ? '　' + x : x; });
    };
    const put = function (text, x, y, size, color, weight, maxW, lh) {
      g.fillStyle = color; g.font = FONT(weight || 400, size);
      const lines = maxW ? wrap(text, maxW, size, weight) : [String(text)];
      lines.forEach(function (ln, i) { g.fillText(ln, x, y + i * (lh || size + 8)); });
      return y + lines.length * (lh || size + 8);
    };
    const putFit = function (text, x, y, size, minSize, color, weight, maxW) {
      let sz = size;
      g.font = FONT(weight || 400, sz);
      while (sz > minSize && g.measureText(String(text)).width > maxW) { sz -= 1; g.font = FONT(weight || 400, sz); }
      g.fillStyle = color; g.font = FONT(weight || 400, sz);
      g.fillText(String(text), x, y);
    };

    const s = res.sim, cfg = res.cfg;
    g.fillStyle = '#f5f6f8'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f5fa6'; g.fillRect(0, 0, W, 12);
    put('长期卡对账台', 72, 106, 50, '#161b22', 700);
    put(TYPE_NAME[cfg.payType] + '：实付 ' + M0(cfg.cardPrice) + ' 元 / 单次 ' + M2(cfg.perUsePrice) + ' 元 / 每月 ' + T2(cfg.visitsPerMonth) + ' 次', 72, 150, 23, '#4a5568', 400, W - 144);

    /* 结论 176–360 */
    const win = s.savingPV > 0;
    g.fillStyle = win ? '#e8f6ef' : '#fdeceb'; g.fillRect(72, 176, W - 144, 184);
    put('按这组假设：' + res.verdict.label, 96, 222, 34, win ? '#0f7b52' : '#b42318', 700, W - 240);
    put('全程按次付 ' + M2(s.costNoCard) + ' 元（现值）　vs　买卡 ' + M2(s.costWithCard) + ' 元（现值）', 96, 272, 25, '#161b22', 500, W - 240);
    put((win ? '省 ' : '多花 ') + M2(Math.abs(s.savingPV)) + ' 元　·　盈亏平衡每月 ' +
      (s.breakevenPerMonth === null ? '—' : (isFinite(s.breakevenPerMonth) ? T2(s.breakevenPerMonth) + ' 次' : '做不到')), 96, 320, 25, '#161b22', 700, W - 240);

    /* KPI 380–500 */
    const kpi = [
      ['卡价 ÷ 单次价', T2(s.visitsToPayback) + ' 次'],
      ['回本年份', YR(s.paybackYears) + ' 年'],
      ['折扣价值（不折现）', M2(s.cumValue)],
      ['摊到次数上的成本', M2(res.laws.costPerVisit) + '/次']
    ];
    kpi.forEach(function (x, i) {
      const px = 72 + (i % 2) * 476, py = 380 + Math.floor(i / 2) * 122;
      g.fillStyle = '#fff'; g.fillRect(px, py, 452, 114);
      g.strokeStyle = '#e3e6eb'; g.strokeRect(px, py, 452, 114);
      g.fillStyle = '#4a5568'; g.font = FONT(400, 22); g.fillText(x[0], px + 24, py + 38);
      putFit(x[1], px + 24, py + 86, 34, 20, '#161b22', 700, 404);
    });

    /* 逐年 640–940 */
    put('逐年：店还开着 × 到访衰减 × 折现', 72, 662, 28, '#161b22', 700, W - 144);
    const cols = [72, 300, 470, 640, 810, 976];
    g.fillStyle = '#7b8794'; g.font = FONT(400, 20);
    ['第几年', '还开着', '去几次', '当年折扣', '累计折扣', '累计净值'].forEach(function (t, i) {
      g.fillText(t, cols[i] - (i >= 4 ? 70 : 0), 698);
    });
    g.strokeStyle = '#e3e6eb'; g.beginPath(); g.moveTo(72, 710); g.lineTo(W - 72, 710); g.stroke();
    let ry = 744;
    const show = res.rows.length <= 6 ? res.rows : res.rows.slice(0, 5).concat([res.rows[res.rows.length - 1]]);
    /* show 最多 6 行，ry 最多到 744 + 5×31 = 899，落在上面 boxTop（≥946）之上 */
    show.forEach(function (r, i) {
      g.font = FONT(400, 22); g.fillStyle = '#37424f';
      g.fillText('第 ' + r.year + ' 年' + (i === 5 && res.rows.length > 6 ? '（末）' : ''), cols[0], ry);
      g.fillText(P2(r.survive), cols[1], ry);
      g.fillText(T2(r.visits), cols[2], ry);
      g.fillText(M0(r.valueGross), cols[3], ry);
      g.fillText(M0(r.cumValue), cols[4] - 70, ry);
      g.fillStyle = r.net >= 0 ? '#0f7b52' : '#b42318';
      g.fillText(M0(r.net), cols[5] - 70, ry);
      ry += 31;
    });

    /* 要点与三种口径：按 put() 的真实行数往下排，避免文字长出底框与下一段叠字
     * （第一版写死 950→1090 的框高，长句换行后直接压到「三种口径的牌价」上，目检抓到） */
    const LINE = function (sz, lh) { return lh || sz + 8; };
    const estLines = function (text, size, weight, maxW) { return wrap(text, maxW, size, weight).length; };
    const bul1 = '回本需要的次数（' + T2(s.visitsToPayback) + ' 次）与衰减、消失、折现都无关';
    const bul2 = '但「多久能凑够这些次数」完全取决于衰减与消失：本页按 Σ(1−' + P2(cfg.failurePerYear / 100) + ')^t 算出的有效年数之和是 ' +
      T2(s.cumDecayVisits / (cfg.visitsPerMonth * 12)) + ' 年';
    const bul3 = '三个口径都算对、回答的不是同一个问题：卡面年费 ' + M1(s.cardAnnual) + '/年、摊到有效期 ' + s.usedYears + ' 年是 ' +
      M1(s.equivalentAnnual) + '/年、摊到次数是 ' + M1(res.laws.costPerVisit) + '/次';
    const l1 = estLines(bul1, 23, 700, W - 240), l2 = estLines(bul2, 21, 400, W - 240), l3 = estLines(bul3, 21, 400, W - 240);
    const inner = (l1 + l2 + l3) * 29 + 12;
    const boxTop = Math.max(946, 1234 - 96 - inner - 40);       /* 给下面两段留出空间 */
    g.fillStyle = '#eaf2fa'; g.fillRect(72, boxTop, W - 144, inner);
    let by = boxTop + 34;
    by = put(bul1, 96, by, 23, '#0f5fa6', 700, W - 240) + 2;
    by = put(bul2, 96, by, 21, '#161b22', 400, W - 240) + 2;
    put(bul3, 96, by, 21, '#161b22', 400, W - 240);

    /* 三种口径的牌价 */
    let cy = boxTop + inner + 40;
    cy = put('三种口径的牌价', 72, cy, 26, '#161b22', 700, W - 144) + 4;
    cy = put('卡面年费 ' + M1(s.cardAnnual) + '/年　·　按次付 ' + M2(cfg.perUsePrice) + '/次　·　这张卡摊到次数 ' + M1(res.laws.costPerVisit) + '/次',
      72, cy, 22, '#37424f', 400, W - 144) + 2;
    put('累计期望到访 ' + T2(s.cumVisits) + ' 次　·　折扣价值 ' + M2(s.cumValue) + ' 元　·　期末余额 ' + M2(s.balanceLeft) + ' 元',
      72, cy, 22, '#37424f', 400, W - 144);

    /* 页脚 */
    g.fillStyle = '#e3e6eb'; g.fillRect(72, 1232, W - 144, 1);
    put('年到访衰减 ' + P2(cfg.decayPerYear / 100) + ' / 年消失 ' + P2(cfg.failurePerYear / 100) + ' / 年折现 ' + P2(cfg.discountRate / 100) +
      ' / 向前看 ' + cfg.horizonYears + ' 年 / 卡面 ' + cfg.cardYears + ' 年', 72, 1262, 20, '#7b8794', 400, W - 144);
    put('衰减、消失、折现三个假设全部由用户自填，本页不联网、不查任何行业倒闭率、不预测任何商家', 72, 1290, 20, '#7b8794', 400, W - 144);
    put('默认与场景都是虚构示例 · 不构成消费建议', 72, 1318, 20, '#7b8794', 400, W - 144);

    cv.toBlob(function (b) {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '长期卡对账台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      state.exportCount++;
    }, 'image/png');
  }

  /* ── 本机保存 / 导入 ─────────────────────────────── */
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ input: readInput(), items: state.items || null }));
      $('saveState').textContent = '已保存到本机（' + new Date().toLocaleTimeString('zh-CN') + '）。只存在这个浏览器里。';
      toast('已保存到本机');
    } catch (e) { $('saveState').textContent = '这台浏览器不允许本机保存（可能是隐私模式）。'; }
  }

  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      const o = JSON.parse(raw);
      state.items = o && o.items ? o.items : null;
      writeInput(o && o.input ? o.input : o);
      if (!silent) toast('已读取上次保存的输入');
      return true;
    } catch (e) { if (!silent) toast('本机保存的内容读不出来'); return false; }
  }

  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = function () {
      try {
        const o = JSON.parse(String(fr.result));
        if (o && o.app && o.app !== 'lifetime-ledger') throw new Error('不是本页的备份');
        const inp = o && o.input ? o.input : o;
        if (!inp || inp.cardPrice === undefined) throw new Error('结构不对');
        state.items = o && Array.isArray(o.items) ? o.items : null;
        writeInput(inp);
        $('scenario').value = '';
        compute();
        toast('已导入备份' + (o && o.app ? '（' + o.app + '）' : ''));
      } catch (e) { toast('这个备份文件读不出来'); }
    };
    fr.readAsText(file);
  }

  /* ── 事件绑定 ─────────────────────────────────────── */
  function bind() {
    const form = $('form');
    form.addEventListener('input', function (e) {
      if (e.target.matches('input[type=text]')) { toggleCond(); compute(); }
    });
    form.addEventListener('change', function (e) {
      if (e.target.matches('select, input[type=checkbox]')) { toggleCond(); compute(); }
    });
    $('cardBody').addEventListener('click', function (e) {
      const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
      if (!tr) return;
      state.sel = Number(tr.getAttribute('data-i'));
      render(state.res);
    });
    $('btnReset').addEventListener('click', function () {
      state.items = null;
      writeInput(C.defaultsClone());
      $('scenario').value = 'base';
      compute(); toast('已恢复默认虚构示例');
    });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', function () { if (loadLocal(false)) { $('scenario').value = ''; compute(); } });
    $('scenario').addEventListener('change', function (e) {
      const id = e.target.value;
      if (!id) return;
      const sc = C.scenarios.filter(function (x) { return x.id === id; })[0];
      if (!sc) return;
      const d = C.defaultsClone();
      Object.assign(d, sc.patch);
      state.items = null;
      writeInput(d); state.sel = 0; compute();
      toast('已换上场景：' + String(sc.name).split(/[：/]/)[0].trim());
    });
    $('btnCsv').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('长期卡对账台.csv', csvText(), 'text/csv;charset=utf-8'); toast('CSV 已导出'); });
    $('btnMd').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('长期卡对账台.md', mdText(), 'text/markdown;charset=utf-8'); toast('Markdown 已导出'); });
    $('btnJson').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); download('长期卡对账台-备份.json', jsonBackup(), 'application/json'); toast('JSON 备份已导出'); });
    $('btnPng').addEventListener('click', function () { if (!state.res) return toast('先让输入通过校验'); pngCard(); toast('结果卡 PNG 正在生成'); });
    $('btnPrint').addEventListener('click', function () { window.print(); });
    $('importFile').addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); });
  }

  function boot() {
    fillSelects();
    state.items = C.defaultsClone().items;
    writeInput(C.defaultsClone());
    $('scenario').value = 'base';
    bind();
    compute();
    const saved = loadLocal(true);
    if (saved) { $('scenario').value = ''; compute(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 给验收脚本用的只读钩子（不改变页面行为） */
  window.__ltc = {
    state: state,
    res: function () { return state.res; },
    checks: function () { return state.checks; },
    renderCount: function () { return state.renders; }
  };
})();
