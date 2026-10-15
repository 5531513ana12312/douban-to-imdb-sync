// ==UserScript==
// @name         豆瓣看过 → IMDb（无依赖修复版）
// @namespace    local.douban-imdb.transfer
// @version      2026.10.14.5
// @license      MIT
// @author       原作者 ryen (Anderson-Ryen)；改版维护 5531513ana12312
// @description  豆瓣看过与评分迁移到 IMDb；缺号搜索、可选 1–16 部并行、测速与保存核验。
// @match        https://movie.douban.com/*
// @match        https://www.imdb.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      v3.sg.media-imdb.com
// ==/UserScript==

(() => {
  'use strict';

  // Adapted from https://github.com/Adsryen/Douban-to-IMDb
  // Original copyright (c) 2026 Anderson-Ryen. MIT License; see LICENSE.

  // 不依赖 jQuery、string.js 或第三方 CDN；无需提供密码或 Cookie。
  const STORE = 'dbimdb:v1:queue';
  const LOCK = 'dbimdb:v1:lock';
  const JOB = 'dbimdb:v1:job:';
  const CACHE = 'dbimdb:v2:search:';
  const DAY = 86400000;
  let lastDetailRequest = 0;
  let lastSearchRequest = 0;
  let requestsStopped = false;
  const WORK_TIMEOUT = 240000;
  const MAX_PARALLEL = 16;
  const TAB_GAP = 350;
  const ACCOUNT_WAIT = 15000;
  const VERIFY_WAIT = 20000;
  const ACK_WAIT = 4000;
  const RELOAD_DELAY = 1500;
  const MAX_RELOADS = 2;
  const RECOVERY_WAIT = 30000;
  const MAX_RECOVERIES = 3;
  const BATCH_SIZE = 30;
  const BATCH_WAIT = 20000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const uuid = () => crypto.randomUUID();
  const get = (key, fallback = null) => GM_getValue(key, fallback);
  const put = (key, value) => GM_setValue(key, value);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const terminal = state => ['done', 'error', 'canceled', 'review'].includes(state);
  const statusNames = { pending: '待同步', running: '处理中', done: '已完成', kept: '保留原评分', error: '需处理', review: '待核对' };
  const unique = values => [...new Set(values.filter(Boolean))];
  const uniqueCandidates = values => [...new Map(values.filter(v => /^tt\d{5,12}$/.test(v?.id || '')).map(v => [v.id, v])).values()];
  const normal = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const stripYear = value => String(value).replace(/\s*[（(]?\b(?:18|19|20)\d{2}[）)]?\s*$/, '').trim();
  const names = value => unique([String(value || '').trim(), ...(String(value || '').match(/[A-Za-zÀ-ž][A-Za-zÀ-ž .’'-]+/g) || []).map(v => v.trim())]);

  // 并行数不改变豆瓣详情与公开搜索的请求间隔。
  async function requestSlot(kind) {
    const stopped = () => { if (requestsStopped) throw Object.assign(new Error('已暂停，取消尚未发出的请求。'), { deferred: true }); };
    stopped();
    const now = Date.now();
    const last = kind === 'detail' ? lastDetailRequest : lastSearchRequest;
    const gap = kind === 'detail' ? 550 : 350;
    const at = Math.max(now, last + gap);
    if (kind === 'detail') lastDetailRequest = at; else lastSearchRequest = at;
    if (at > now) await sleep(at - now);
    stopped();
  }

  function jsonEntities(doc) {
    const entities = [];
    function visit(value) {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      entities.push(value);
      if (value['@graph']) visit(value['@graph']);
    }
    for (const script of $$('script[type="application/ld+json"]', doc)) {
      try { visit(JSON.parse(script.textContent)); } catch (_) { /* 站点资料可能不完整 */ }
    }
    return entities;
  }

  function minutes(value) {
    if (typeof value === 'number') return value;
    const iso = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (iso) return Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
    return Number(String(value || '').match(/(\d+)\s*(?:分钟|min)/i)?.[1]) || null;
  }

  function doubanMetadata(doc, item) {
    const entity = jsonEntities(doc).find(v => /Movie|TVSeries|VideoObject/.test([v['@type']].flat().join(' '))) || {};
    const h1 = text($('h1', doc));
    const info = $('#info', doc);
    const rawInfo = info?.textContent || '';
    const aliases = rawInfo.match(/又名\s*[:：]\s*([^\n]+?)(?=\n|\s*IMDb\s*[:：]|$)/i)?.[1] || '';
    const year = Number(h1.match(/[（(](\d{4})[）)]/)?.[1]);
    const directorLinks = $$('[rel="v:directedBy"]', doc);
    const directors = [entity.director].flat().filter(Boolean).flatMap(v => names(v.name));
    for (const link of directorLinks) {
      directors.push(...names(text(link)), ...names(link.getAttribute('title')));
      const href = link.getAttribute('href');
      for (const same of $$('a[href]', doc).filter(a => a.getAttribute('href') === href)) {
        directors.push(...names(same.getAttribute('title')), ...names(text(same)));
      }
    }
    return {
      titles: unique([entity.name, text($('[property="v:itemreviewed"]', doc)), h1.replace(/\s*[（(]\d{4}[）)]\s*$/, ''),
        ...item.title.split(/\s+\/\s+/), ...aliases.split(/\s*\/\s*/)].map(v => String(v || '').trim())),
      years: unique([year || null, ...$$('[property="v:initialReleaseDate"]', doc).map(n => Number(text(n).match(/\b\d{4}\b/)?.[0]) || null),
        Number(String(entity.datePublished || '').slice(0, 4)) || null]),
      directors: unique(directors),
      actors: unique([entity.actor].flat().filter(Boolean).flatMap(v => names(v.name))),
      duration: minutes(entity.duration) || Number(rawInfo.match(/片长\s*[:：]\s*(\d+)/)?.[1]) || null,
      type: entity['@type'] || '', fetchedAt: Date.now()
    };
  }

  function imdbMetadata(doc, id) {
    const entities = jsonEntities(doc);
    const entity = entities.find(v => /Movie|TVSeries|VideoObject|TVEpisode/.test([v['@type']].flat().join(' '))) || {};
    let data = {};
    try {
      const props = JSON.parse($('#__NEXT_DATA__', doc)?.textContent || '{}').props?.pageProps;
      data = props?.aboveTheFoldData || props?.mainColumnData || {};
    } catch (_) { /* 使用可见页面的结构化资料 */ }
    const directors = [entity.director].flat().filter(Boolean).flatMap(v => names(v.name));
    for (const credit of data.principalCredits || []) {
      if (credit.category?.id === 'director') for (const person of credit.credits || []) directors.push(...names(person.name?.nameText?.text));
    }
    const decode = value => { const node = document.createElement('textarea'); node.innerHTML = String(value || ''); return node.value; };
    const sourceIds = unique([entity.url, entity['@id'], data.id].map(value => String(value || '').match(/\btt\d{5,12}\b/)?.[0]));
    return {
      id: sourceIds.length === 1 ? sourceIds[0] : null,
      titles: unique([entity.name, ...[entity.alternateName].flat(), data.titleText?.text, data.originalTitleText?.text, text($('h1', doc))].filter(Boolean).map(decode)),
      years: unique([data.releaseYear?.year, Number(String(entity.datePublished || '').slice(0, 4)) || null]),
      directors: unique(directors), actors: unique([entity.actor].flat().filter(Boolean).flatMap(v => names(v.name))),
      duration: minutes(entity.duration) || (data.runtime?.seconds ? data.runtime.seconds / 60 : null), type: entity['@type'] || '',
      validIdentity: sourceIds.length === 1 && sourceIds[0] === id
    };
  }

  function matchEvidence(source, candidate) {
    const originals = (source.titles || []).map(normal);
    const titles = (candidate.titles || [candidate.title]).map(normal);
    const exact = originals.some(n => n && titles.includes(n));
    const base = (source.titles || []).map(v => normal(stripYear(v))).some(n => n && (candidate.titles || [candidate.title]).map(v => normal(stripYear(v))).includes(n));
    const years = (source.years || []).map(Number).filter(Boolean);
    const otherYears = (candidate.years || [candidate.year]).map(Number).filter(Boolean);
    const delta = years.length && otherYears.length ? Math.min(...years.flatMap(a => otherYears.map(b => Math.abs(a - b)))) : null;
    const latinDirectors = values => (values || []).flatMap(names).filter(v => /[a-z]/i.test(v) && !/[\u3400-\u9fff]/u.test(v))
      .map(v => v.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(''));
    const sd = latinDirectors(source.directors), cd = latinDirectors(candidate.directors);
    const sameDirector = sd.some(n => cd.includes(n));
    const directorConflict = sd.length > 0 && cd.length > 0 && !sameDirector;
    const durationConflict = source.duration && candidate.duration && Math.abs(source.duration - candidate.duration) > Math.max(5, source.duration * .1);
    const possible = (exact || base) && (delta === null || delta <= 1) && !directorConflict && !durationConflict;
    const strong = possible && (exact && delta === 0 || sameDirector && (delta === null || delta <= 1));
    return { possible: !!possible, strong: !!strong, exact, delta, sameDirector,
      reason: directorConflict ? '导演不一致' : durationConflict ? '片长不一致' : delta !== null && delta > 1 ? '年份不一致' : !exact && !base ? '片名不一致' : strong ? '片名及年份/导演吻合' : '资料不足或年份存在差异' };
  }

  async function imdbSuggestions(query) {
    const key = CACHE + query.normalize('NFKC').toLowerCase().trim();
    const cached = get(key);
    if (cached?.until > Date.now()) return cached.values;
    await requestSlot('search');
    const refreshed = get(key);
    if (refreshed?.until > Date.now()) return refreshed.values;
    const response = await new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('搜索权限未启用，请完整更新脚本并允许 IMDb 搜索连接。')); return; }
      GM_xmlhttpRequest({ method: 'GET', url: `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`,
        anonymous: true, timeout: 18000,
        onload: resolve, onerror: () => reject(new Error('IMDb 搜索连接失败，可在待核对区域重试或手动填入链接。')),
        ontimeout: () => reject(new Error('IMDb 搜索超时，可稍后重试。')) });
    });
    if (response.status !== 200) {
      const error = new Error(`IMDb 搜索返回 ${response.status}，请稍后再试。`);
      error.pauseQueue = [429, 503].includes(response.status); throw error;
    }
    let parsed;
    try { parsed = JSON.parse(response.responseText); } catch (_) { throw new Error('IMDb 搜索未返回有效资料，请稍后重试。'); }
    if (!Array.isArray(parsed.d)) throw new Error('IMDb 搜索返回的资料格式已改变。');
    const values = parsed.d.filter(v => /^tt\d{5,12}$/.test(v.id || '') && v.l && !/episode|game/i.test(v.qid || v.q || '')).map(v => ({ id: v.id, title: v.l, year: v.y || null, type: v.qid || v.q || '', cast: v.s || '' }));
    put(key, { until: Date.now() + (values.length ? DAY * 7 : DAY), values });
    return values;
  }

  async function searchMatching(item, queryOverride) {
    const source = item.metadata || { titles: item.title.split(/\s+\/\s+/), years: [], directors: [] };
    const titles = unique(source.titles || []);
    const queries = queryOverride ? [queryOverride.trim()] : unique([
      ...titles.filter(v => /[a-z]{3}/i.test(v) && !/[\u3400-\u9fff]/u.test(v)), ...titles
    ].flatMap(v => [v, stripYear(v)])).slice(0, 4);
    const candidates = new Map();
    let errorMessage = '';
    for (const query of queries) {
      if (!query) continue;
      try {
        for (const candidate of await imdbSuggestions(query)) candidates.set(candidate.id, candidate);
      } catch (error) {
        if (error.pauseQueue) throw error;
        errorMessage = error.message; break;
      }
      const possible = [...candidates.values()].filter(c => matchEvidence(source, c).possible);
      // 同一个标题查询中若有两个可能条目，保留供用户核对，不猜选第一条。
      if (possible.length) break;
    }
    const values = [...candidates.values()].sort((a, b) => Number(matchEvidence(source, b).possible) - Number(matchEvidence(source, a).possible)).slice(0, 12);
    const possible = values.filter(c => matchEvidence(source, c).possible);
    // 搜索接口有时只返回英文名，原名在影片页面才能读取。
    // 仅有一个同年候选时允许进一步打开核对；工作页仍须通过原名/年份等检查才会写入。
    const sameYear = values.filter(c => c.year && (source.years || []).includes(Number(c.year)));
    const selected = possible.length === 1 ? possible[0] : possible.length === 0 && sameYear.length === 1 ? sameYear[0] : null;
    return { selected, candidates: values, errorMessage };
  }

  function element(tag, content, parent) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (parent) parent.append(node);
    return node;
  }

  // Shadow DOM 隔离站点样式；电影标题只作为文本插入。
  function panel(title) {
    const host = element('div');
    host.id = 'dbimdb-helper';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:calc(100vw - 24px)';
    const root = host.attachShadow({ mode: 'open' });
    element('style', `
      :host {all:initial;font-family:system-ui,-apple-system,sans-serif;color:#202429;font-size:14px}
      * {box-sizing:border-box} .box {width:390px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #ccd5ce;border-radius:14px;box-shadow:0 8px 36px #0003;padding:16px}
      header {display:flex;align-items:center;gap:10px} h2 {font-size:17px;line-height:1.5;margin:0;flex:1} p {line-height:1.6;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}
      button,select {font:inherit;border:1px solid #c9d3ca;border-radius:7px;padding:7px 9px;background:#f6faf6;color:#203626;cursor:pointer}
      button:hover {background:#e8f4e9} button:disabled {opacity:.45;cursor:default} .actions {display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
      .primary {background:#24733e;color:white} .primary:hover {background:#1a5b30} select {width:100%;margin:5px 0} label {display:block;font-size:12px;margin:8px 0;line-height:1.6}
      .log {max-height:170px;overflow:auto;font-size:12px;line-height:1.65;border-top:1px solid #eee;padding-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}
      .muted {font-size:12px;color:#526359} a {color:#1765ac} details {margin:8px 0} summary {cursor:pointer}
      input:not([type="checkbox"]) {width:100%;font:inherit;border:1px solid #c9d3ca;border-radius:6px;padding:6px;margin:5px 0}
    `, root);
    const box = element('section', undefined, root);
    box.className = 'box';
    const header = element('header', undefined, box);
    element('h2', title, header);
    const toggle = element('button', '收起', header);
    const body = element('div', undefined, box);
    toggle.onclick = () => { body.hidden = !body.hidden; toggle.textContent = body.hidden ? '展开' : '收起'; };
    document.body.append(host);
    GM_registerMenuCommand('显示豆瓣 → IMDb 面板', () => { body.hidden = false; toggle.textContent = '收起'; });
    return body;
  }

  function sourcePath(url) {
    const parsed = new URL(url, location.href);
    if (parsed.hostname === 'movie.douban.com' && parsed.pathname === '/mine' && parsed.searchParams.get('status') === 'collect') {
      const link = $$('#db-usr-profile a[href]').find(a => /^\/people\/[^/]+\/collect\/?$/.test(new URL(a.href, parsed).pathname));
      if (link) return sourcePath(link.href);
    }
    return parsed.hostname === 'movie.douban.com' && /^\/people\/[^/]+\/collect\/?$/.test(parsed.pathname)
      ? parsed.pathname.replace(/\/$/, '') : null;
  }

  function parseMovies(doc) {
    const found = new Map();
    for (const item of $$('.grid-view .item', doc)) {
      const link = $('.info .title a[href*="/subject/"]', item) || $('.title a[href*="/subject/"]', item);
      const id = link?.getAttribute('href')?.match(/\/subject\/(\d+)\//)?.[1];
      if (!id) continue;
      const rated = $$('span', item).map(node => node.className.match(/(?:^|\s)rating([1-5])-t(?:\s|$)/)).find(Boolean);
      found.set(id, {
        id, title: text(link), url: `https://movie.douban.com/subject/${id}/`,
        stars: rated ? Number(rated[1]) : null, date: text($('.date', item)),
        imdbId: null, status: 'pending', note: ''
      });
    }
    return [...found.values()];
  }

  function imdbIdFrom(doc) {
    const info = $('#info', doc);
    if (!info) return null;
    const inText = text(info).match(/IMDb\s*[:：]?\s*(tt\d{5,12})\b/i);
    if (inText) return inText[1];
    for (const a of $$('a[href]', info)) {
      try {
        const url = new URL(a.getAttribute('href'), 'https://movie.douban.com');
        if (/^(www\.)?imdb\.com$/.test(url.hostname)) {
          const id = url.pathname.match(/^\/title\/(tt\d{5,12})(?:\/|$)/)?.[1];
          if (id) return id;
        }
      } catch (_) { /* 跳过非链接 */ }
    }
    return null;
  }

  async function fetchDocument(url) {
    const requested = new URL(url, location.href);
    if (requested.origin !== location.origin) throw new Error('停止：豆瓣读取地址超出当前站点。');
    await requestSlot('detail');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25000);
    try {
      const response = await fetch(requested.href, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) throw Object.assign(new Error(`豆瓣返回 ${response.status}，请稍后再试。`), { itemOnly: [404, 410].includes(response.status) });
      const final = new URL(response.url || requested.href);
      if (final.origin !== requested.origin || final.pathname !== requested.pathname) {
        throw new Error('豆瓣跳转到了登录或验证页面，请先在网页完成验证。');
      }
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (/验证码|安全验证|异常请求|访问过于频繁|captcha/i.test(text($('title', doc))) || $('form[action*="captcha"], #captcha_image', doc)) {
        throw new Error('豆瓣要求验证，请在网页完成验证后重试。');
      }
      return doc;
    } finally { clearTimeout(timer); }
  }

  async function douban() {
    const body = panel('豆瓣看过 → IMDb · 快速匹配 2026.10.14.5');
    const note = element('p', '脚本已启动。请在自己的「看过」列表使用。IMDb 请先登录，并将界面语言设为 English。', body);
    note.className = 'muted';
    const summary = element('p', '', body);
    const actions = element('div', undefined, body);
    actions.className = 'actions';
    const scan = element('button', '读取本页', actions);
    const all = element('button', '读取全部看过', actions);
    const mode = element('select', undefined, body);
    for (const [value, label] of [['ratings', '同步评分；未评分的只标记看过'], ['watched', '只标记看过，不写入评分']]) {
      const option = element('option', label, mode); option.value = value;
    }
    const speed = element('select', undefined, body);
    speed.setAttribute('aria-label', '同步速度');
    for (const [value, title] of [['2', '默认：最多 2 部并行'], ['1', '稳妥：每次 1 部'],
      ['4', '加速：最多 4 部并行'], ['6', '加速：最多 6 部并行'], ['8', '高并发：最多 8 部并行'],
      ['10', '高并发：最多 10 部并行'], ['16', '实验：最多 16 部并行']]) {
      const option = element('option', title, speed); option.value = value;
    }
    const savedSpeed = String(get('dbimdb:v3:parallel', 2));
    if ([...speed.options].some(o => o.value === savedSpeed)) speed.value = savedSpeed;
    speed.onchange = () => put('dbimdb:v3:parallel', Number(speed.value));
    const performanceNote = element('p', '实际速度会在同步时显示。自动稳速会安排休息并在账户故障后降速续传；登录或验证提示仍需你处理。', body);
    performanceNote.className = 'muted';
    const recoveryLabel = element('label', undefined, body);
    const autoResume = element('input', undefined, recoveryLabel);
    autoResume.type = 'checkbox'; autoResume.checked = get('dbimdb:v5:autoResume', true) !== false;
    recoveryLabel.append(' 自动稳速：每 30 部休息 20 秒；账户加载失败后等待、降到单部续传');
    autoResume.onchange = () => put('dbimdb:v5:autoResume', autoResume.checked);
    const label = element('label', undefined, body);
    const overwrite = element('input', undefined, label);
    overwrite.type = 'checkbox';
    label.append(' 覆盖 IMDb 已有的不同评分（默认保留）');
    const controls = element('div', undefined, body);
    controls.className = 'actions';
    const pilot = element('button', '先试 1 部', controls);
    pilot.className = 'primary';
    const start = element('button', '同步待处理', controls);
    const pause = element('button', '暂停', controls);
    const retry = element('button', '失败项重试', controls);
    const extras = element('div', undefined, body);
    extras.className = 'actions';
    const download = element('button', '导出记录', extras);
    const clear = element('button', '清空队列', extras);
    const log = element('div', '', body);
    log.className = 'log';
    const reviewBox = element('div', '', body);
    reviewBox.className = 'log';
    const footer = element('p', '缺少编号会自动搜索；有歧义的结果请在「待核对」选择。评分按 1–5 星 → 2–10 分转换。暂停会停止开启新工作页，已开启的工作页完成后停下。同步时保持豆瓣控制页在前台。', body);
    footer.className = 'muted';

    let queue = get(STORE, { source: null, items: [] });
    if (!queue || !Array.isArray(queue.items)) queue = { source: null, items: [] };
    let busy = false;
    let stopRequested = false;
    const activeTokens = new Set();
    const owner = uuid();
    let heartbeat;
    const save = () => put(STORE, queue);
    const say = message => { summary.textContent = message; };
    function render(message) {
      const counts = queue.items.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out; }, {});
      say(message || `共 ${queue.items.length} 部 · 已完成 ${counts.done || 0} · 保留 ${counts.kept || 0} · 待处理 ${counts.pending || 0} · 待核对 ${counts.review || 0} · 需处理 ${counts.error || 0}`);
      const prioritized = [...queue.items.filter(i => ['error', 'running'].includes(i.status)), ...queue.items.filter(i => !['error', 'running'].includes(i.status))];
      log.textContent = prioritized.slice(0, 70).map(i => `${statusNames[i.status] || i.status} · ${i.title} · ${i.stars ? i.stars + '星' : '无评分'}${i.note ? '\n  ' + i.note : ''}`).join('\n');
      for (const b of [scan, all, pilot, start, retry, clear, mode, speed, overwrite, autoResume]) b.disabled = busy;
      pause.disabled = !busy;
      renderReview();
    }

    function renderReview() {
      reviewBox.replaceChildren();
      const items = queue.items.filter(i => i.status === 'review' || i.status === 'error' && !i.imdbId);
      if (!items.length) { reviewBox.hidden = true; return; }
      reviewBox.hidden = false;
      element('p', `待核对 ${items.length} 部：选择候选后，点「同步待处理」。`, reviewBox);
      for (const item of items.slice(0, 30)) {
        const details = element('details', undefined, reviewBox);
        element('summary', item.title, details);
        element('p', `豆瓣：${(item.metadata?.years || []).join(' / ') || '年份未知'}；${(item.metadata?.directors || []).join(' / ') || '导演未知'}\n${item.note}`, details);
        for (const candidate of item.candidates || []) {
          const row = element('p', undefined, details);
          const a = element('a', `${candidate.title || candidate.titles?.[0] || candidate.id} (${candidate.year || candidate.years?.join('/') || '?'})`, row);
          a.href = `https://www.imdb.com/title/${candidate.id}/`; a.target = '_blank'; a.rel = 'noopener noreferrer';
          if (candidate.directors?.length) row.append(` · ${candidate.directors.join(' / ')}`);
          const choose = element('button', '选用此条目', row); choose.disabled = busy;
          choose.onclick = () => exclusive(async () => {
            const current = queue.items.find(v => v.id === item.id);
            current.imdbId = candidate.id; current.matchSource = 'manual'; current.status = 'pending';
            current.note = `已手动选择 ${candidate.id}，等待同步`; save(); render();
          });
        }
        const input = element('input', undefined, details);
        input.placeholder = 'IMDb 链接或 tt 编号'; input.setAttribute('aria-label', `为 ${item.title} 填入 IMDb 编号`);
        const apply = element('button', '保存编号', details); apply.disabled = busy;
        apply.onclick = () => exclusive(async () => {
          const raw = input.value.trim();
          let id = /^tt\d{5,12}$/.test(raw) ? raw : null;
          if (!id) {
            try { const u = new URL(raw); if (/^(www\.)?imdb\.com$/.test(u.hostname)) id = u.pathname.match(/^\/title\/(tt\d{5,12})(?:\/|$)/)?.[1]; } catch (_) { /* 等待有效输入 */ }
          }
          if (!id) throw new Error('请输入完整 IMDb 影片链接或 tt 开头的编号。');
          const current = queue.items.find(v => v.id === item.id);
          current.imdbId = id; current.matchSource = 'manual'; current.status = 'pending'; current.note = `已手动指定 ${id}，等待同步`;
          save(); render();
        });
        const query = element('input', undefined, details);
        query.placeholder = '换用原名或英文名搜索'; query.setAttribute('aria-label', `重新搜索 ${item.title}`);
        const search = element('button', '搜索名称', details); search.disabled = busy;
        search.onclick = () => exclusive(async () => {
          if (!query.value.trim()) throw new Error('请填入用于搜索的原名或英文名。');
          const current = queue.items.find(v => v.id === item.id);
          say(`正在搜索 ${query.value.trim()}……`);
          const result = await searchMatching(current, query.value.trim());
          current.candidates = result.candidates; current.status = 'review'; current.note = result.errorMessage || '请核对影片后选择对应条目。';
          save(); render();
        });
      }
      if (items.length > 30) element('p', '先处理以上 30 部，完成后会显示后面的条目。', reviewBox);
    }

    async function acquire() {
      const existing = get(LOCK);
      if (existing && existing.until > Date.now() && existing.owner !== owner) throw new Error('另一个豆瓣标签页正在处理，请先在那里暂停。');
      put(LOCK, { owner, until: Date.now() + 240000 });
      await sleep(120);
      if (get(LOCK)?.owner !== owner) throw new Error('另一个标签页先开始了，请使用那个页面。');
      heartbeat = setInterval(() => {
        if (get(LOCK)?.owner === owner) put(LOCK, { owner, until: Date.now() + 240000 });
      }, 10000);
      queue = get(STORE, queue);
      for (const item of queue.items) {
        if (item.status !== 'running') continue;
        const job = item.token && get(JOB + item.token);
        if (job?.state === 'review') {
          item.status = 'review'; item.note = job.note;
          if (job.candidate) item.candidates = uniqueCandidates([job.candidate, ...(item.candidates || [])]);
        } else if (job?.state === 'done') {
          item.status = job.outcome === 'kept' ? 'kept' : 'done'; item.note = job.note;
        } else {
          if (job && !terminal(job.state)) put(JOB + item.token, { ...job, state: 'canceled', note: '上次操作已中断。' });
          item.status = 'error'; item.note = '上次中断；可点击「失败项重试」，会先检查 IMDb 现有状态。';
        }
      }
      save();
    }

    async function exclusive(task) {
      if (busy) return;
      busy = true; stopRequested = false; requestsStopped = false; render();
      try { await acquire(); await task(); }
      catch (error) { say(error.message || String(error)); }
      finally {
        busy = false;
        requestsStopped = false;
        clearInterval(heartbeat);
        if (get(LOCK)?.owner === owner) GM_deleteValue(LOCK);
        for (const b of [scan, all, pilot, start, retry, clear, mode, speed, overwrite, autoResume]) b.disabled = false;
        pause.disabled = true;
        for (const b of $$('button', reviewBox)) b.disabled = false;
      }
    }

    function merge(items) {
      const known = new Map(queue.items.map(i => [i.id, i]));
      for (const item of items) if (!known.has(item.id)) { queue.items.push(item); known.set(item.id, item); }
      save(); render();
    }

    async function collect(everyPage) {
      const path = sourcePath(location.href);
      if (!path) throw new Error('请先打开豆瓣电影 → 我的主页 → 看过，网址形如 movie.douban.com/people/你的ID/collect。');
      if (queue.source && queue.source !== path && queue.items.length) throw new Error('队列来自另一个用户的列表。请先导出记录并清空队列。');
      queue.source = path;
      let url = new URL(location.href);
      if (everyPage) {
        // 从未筛选的第一页开始，避免漏掉标签、年份或评分筛选外的影片。
        url = new URL(path, location.origin);
        url.search = '?start=0&sort=time&rating=all&filter=all&mode=grid';
      }
      const visited = new Set();
      let pages = 0;
      while (!stopRequested) {
        if (visited.has(url.href)) throw new Error('豆瓣分页重复，已停止；已读取的记录已保存。');
        visited.add(url.href);
        say(`正在读取第 ${++pages} 页；已收集 ${queue.items.length} 部……`);
        const doc = !everyPage ? document : await fetchDocument(url);
        const movies = parseMovies(doc);
        if (!movies.length) throw new Error('没有读到影片。请确认是网格形式的「看过」列表，且页面没有登录提示或验证码。');
        merge(movies);
        const next = $('.paginator .next a[href], a[rel="next"][href]', doc);
        if (!everyPage || !next) break;
        const nextUrl = new URL(next.getAttribute('href'), url);
        if (nextUrl.origin !== location.origin || sourcePath(nextUrl.href) !== path) throw new Error('分页地址不符合当前列表，已停止。');
        url = nextUrl;
        await sleep(550);
      }
      render(stopRequested ? `已暂停读取，已保存 ${queue.items.length} 部。再次读取全部会自动去重。` : undefined);
    }

    async function sync(limit) {
      let candidates = queue.items.filter(i => i.status === 'pending');
      if (!candidates.length) throw new Error('没有待同步影片。先读取列表；失败项目请点「失败项重试」。');
      const settings = { mode: mode.value, overwrite: overwrite.checked };
      const parallel = limit === 1 ? 1 : Math.min(MAX_PARALLEL, Math.max(1, Number(speed.value) || 2));
      const inFlightIds = new Set();
      const failedItems = new Set(), recovering = new Set();
      const automatic = autoResume.checked;
      let completed = 0, reviews = 0, index = 0, pauseReason = '';
      let effectiveParallel = parallel, recoveryRequested = false, recoveryRound = 0, healthyStreak = 0, openedSinceRest = 0;
      let nextTabAt = 0, lastTabAt = 0, activeTabs = 0;
      const startedAt = Date.now();
      function progress() {
        const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const failed = [...failedItems].filter(i => i.status === 'error').length;
        performanceNote.textContent = `设置上限 ${parallel} 部 · 当前并行 ${effectiveParallel} 部 · 工作页 ${activeTabs} 个 · 已确认 ${completed} 部 · 待核对 ${reviews} 部 · 需处理 ${failed} 部 · ${(completed * 60 / seconds).toFixed(1)} 部/分钟 · 用时 ${Math.round(seconds)} 秒（含跳过与保留原评分）`;
      }
      const progressTimer = setInterval(progress, 1000);
      progress();
      function deferStopped(item) {
        if (!stopRequested && !recoveryRequested && !(automatic && openedSinceRest >= BATCH_SIZE)) return false;
        item.status = 'pending'; item.note = stopRequested ? '已暂停，等待同步' : '暂缓开页，等待稳速恢复'; save(); render(); return true;
      }
      async function cooldown(ms, title) {
        const until = Date.now() + ms;
        while (!stopRequested && Date.now() < until) {
          if (get(LOCK)?.owner !== owner) throw new Error('任务控制权已改变，停止恢复。');
          say(`${title} · 剩余 ${Math.ceil((until - Date.now()) / 1000)} 秒；可以点「暂停」停止。`);
          await sleep(Math.min(1000, Math.max(1, until - Date.now())));
        }
      }

      async function process(item) {
        let tab, token, heldId;
        try {
          if (get(LOCK)?.owner !== owner) throw new Error('任务控制权已改变，停止处理。');
          item.status = 'running'; item.note = '正在读取影片资料'; save(); render();
          if (!item.imdbId) {
            if (!item.metadata || !Number.isFinite(item.metadata.fetchedAt) || Date.now() - item.metadata.fetchedAt > DAY * 14) {
              const doc = await fetchDocument(new URL(`/subject/${item.id}/`, location.origin));
              item.metadata = doubanMetadata(doc, item);
              item.imdbId = imdbIdFrom(doc);
              if (item.imdbId) item.matchSource = 'douban';
              save();
              if (deferStopped(item)) return;
            }
            if (!item.imdbId) {
              item.note = '豆瓣缺少编号，正在用片名、原名和别名搜索 IMDb……'; save(); render();
              const result = await searchMatching(item);
              if (deferStopped(item)) return;
              item.candidates = result.candidates;
              if (!result.selected) {
                reviews++; item.status = 'review';
                item.note = result.errorMessage || (result.candidates.length ? '未找到唯一可靠匹配，请在下方核对候选或换名称搜索。' : '搜索未找到可确认的条目；可换名称搜索，或手动填入 IMDb 链接。');
                save(); render(); return;
              }
              item.imdbId = result.selected.id; item.matchSource = 'search';
              item.note = `找到候选 ${result.selected.title} (${result.selected.year || '?'})，正在 IMDb 页面进一步核对`;
              save(); render();
            }
          }
          // 同一 IMDb 条目即使来自两条豆瓣记录，也不得并发改写个人评分。
          while (inFlightIds.has(item.imdbId)) {
            if (deferStopped(item)) return;
            await sleep(200);
          }
          heldId = item.imdbId; inFlightIds.add(heldId);
          // 控制页统一排队开页，避免同时开启十几个网页造成瞬间请求高峰。
          const openAt = Math.max(Date.now(), nextTabAt);
          nextTabAt = openAt + TAB_GAP;
          if (openAt > Date.now()) await sleep(openAt - Date.now());
          // 后台计时器或繁忙页面可能将多个预约一起唤醒，再核对实际开页间隔。
          while (!stopRequested && !recoveryRequested && Date.now() < lastTabAt + TAB_GAP) await sleep(lastTabAt + TAB_GAP - Date.now());
          if (deferStopped(item)) return;
          if (get(LOCK)?.owner !== owner) throw new Error('任务控制权已改变，停止处理。');
          token = uuid(); activeTokens.add(token); item.token = token;
          put(JOB + token, { token, owner, imdbId: item.imdbId, title: item.title, stars: item.stars,
            ...settings, state: item.autoVerify ? 'verify' : 'pending', desired: item.autoVerify || undefined,
            autoRecovery: automatic, createdAt: Date.now(),
            matchCheck: item.matchSource === 'search', sourceMetadata: item.metadata,
            candidates: item.candidates || [] });
          save();
          tab = GM_openInTab(`https://www.imdb.com/title/${item.imdbId}/#dbimdb=${token}`, { active: false, insert: true, setParent: true });
          lastTabAt = Date.now();
          if (!tab) throw new Error('无法打开 IMDb 标签页，请检查 Tampermonkey 网站访问权限。');
          activeTabs++; openedSinceRest++; progress();
          const deadline = Date.now() + WORK_TIMEOUT;
          let result, lastNote = '';
          while (Date.now() < deadline) {
            result = get(JOB + token);
            if (result && terminal(result.state)) break;
            if (tab.closed) throw new Error('IMDb 标签页在确认前被关闭。');
            const nextNote = result?.note || '等待 IMDb 页面启动；请保持豆瓣控制页在前台，IMDb 工作页打开';
            if (nextNote !== lastNote) { item.note = nextNote; lastNote = nextNote; render(); }
            await sleep(250);
          }
          result = get(JOB + token);
          if (!result || !terminal(result.state)) throw new Error(`IMDb 等待超时；请检查登录、脚本权限或验证提示。最后状态：${result?.note || '页面未启动'}`);
          if (result.state === 'review') {
            reviews++; item.status = 'review'; item.note = result.note;
            if (result.candidate) item.candidates = uniqueCandidates([result.candidate, ...(item.candidates || [])]);
            item.imdbId = null; save(); render(); tab.close(); return;
          }
          if (result.state !== 'done') throw new Error(result.note || 'IMDb 处理未完成。');
          completed++; healthyStreak++; failedItems.delete(item); delete item.autoVerify;
          item.status = result.outcome === 'kept' ? 'kept' : 'done'; item.note = result.note;
          if (healthyStreak >= 20 && effectiveParallel === 1) effectiveParallel = Math.min(2, parallel);
          if (healthyStreak >= 20) recoveryRound = 0;
          save(); render(); tab.close();
        } catch (error) {
          if (error.deferred && !token) { item.status = 'pending'; item.note = '已暂停，等待同步'; save(); render(); return; }
          if (error.itemOnly && !token) { failedItems.add(item); item.status = 'error'; item.note = error.message; save(); render(); return; }
          const job = token && get(JOB + token);
          if (job && !terminal(job.state)) put(JOB + token, { ...job, state: 'canceled', note: error.message });
          item.status = 'error'; item.note = error.message || String(error); failedItems.add(item);
          if (automatic && job?.recoverable) {
            if (job.desired) item.autoVerify = job.desired;
            recovering.add(item); recoveryRequested = true; requestsStopped = true; healthyStreak = 0;
            save(); if (tab && !tab.closed) tab.close();
            render('IMDb 账户暂未加载成功：停止开新页，等待当前工作页结束后降速恢复。'); return;
          }
          if (job?.errorType === 'verification-missing') {
            // 新页面明确显示目标未保存，保留错误但不再自动写入、不阻塞其他影片。
            delete item.autoVerify; save(); if (tab && !tab.closed) tab.close(); render(); return;
          }
          save();
          stopRequested = true; requestsStopped = true; pauseReason = item.note; render('已暂停：' + item.note);
        } finally {
          if (tab) activeTabs--;
          progress();
          if (token) activeTokens.delete(token);
          if (heldId) inFlightIds.delete(heldId);
        }
      }

      async function run() {
        while (!stopRequested && !recoveryRequested && !(automatic && openedSinceRest >= BATCH_SIZE) && index < candidates.length && completed < limit) {
          const item = candidates[index++];
          await process(item);
          if (!stopRequested && !recoveryRequested && index < candidates.length && completed < limit) await sleep(250);
        }
      }
      try {
        while (!stopRequested && candidates.length && completed < limit) {
          index = 0; recoveryRequested = false; recovering.clear();
          await Promise.all(Array.from({ length: effectiveParallel }, run));
          if (stopRequested || completed >= limit) break;
          if (recoveryRequested) {
            if (++recoveryRound > MAX_RECOVERIES) { stopRequested = true; pauseReason = 'IMDb 连续恢复失败，已保留未确认记录；请检查网络或页面提示后重试。'; break; }
            effectiveParallel = 1;
            for (const item of recovering) { item.status = 'pending'; item.note = item.autoVerify ? '等待冷却，稍后只读核验上次提交' : '等待冷却，稍后重新读取账户状态'; }
            save();
            await cooldown(RECOVERY_WAIT * 2 ** (recoveryRound - 1), `自动恢复 ${recoveryRound}/${MAX_RECOVERIES}：降到 1 部并行`);
            if (stopRequested) break;
            for (const item of recovering) { item.status = 'pending'; item.note = item.autoVerify ? '冷却结束，先只读核验上次提交' : '冷却结束，重新读取账户状态'; }
            save();
          } else if (automatic && openedSinceRest >= BATCH_SIZE && queue.items.some(i => i.status === 'pending')) {
            await cooldown(BATCH_WAIT, '稳速休息，已确认记录已保存');
            if (stopRequested) break;
          } else break;
          openedSinceRest = 0; requestsStopped = false;
          const priority = [...recovering].filter(i => i.status === 'pending');
          candidates = [...priority, ...queue.items.filter(i => i.status === 'pending' && !priority.includes(i))];
        }
      }
      finally { clearInterval(progressTimer); progress(); }
      if (pauseReason) render('已暂停：' + pauseReason + ' 修复后点击「失败项重试」。');
      else if (stopRequested) render('已暂停，当前正在处理的影片已结束。点击「同步待处理」继续。');
      else if (completed === 0) render(`本次没有写入 IMDb：${reviews} 部需要核对，${[...failedItems].filter(i => i.status === 'error').length} 部需处理。请展开下方条目，选择候选或补入链接后同步。`);
      else if (limit === 1) render(`已完成 1 部试同步${reviews ? `，另有 ${reviews} 部待核对` : ''}。请在 IMDb 核对结果后再开始批量同步。`);
      else render();
    }

    scan.onclick = () => exclusive(() => collect(false));
    all.onclick = () => exclusive(() => collect(true));
    pilot.onclick = () => exclusive(async () => {
      if (queue.items.length === 0) await collect(false);
      say('正在查找第一部有 IMDb 编号的待同步影片……');
      await sync(1);
    });
    start.onclick = () => exclusive(() => sync(Infinity));
    pause.onclick = () => { stopRequested = true; requestsStopped = true; say('已请求暂停：停止开启新工作页，等待已开启的工作页完成。'); };
    retry.onclick = () => exclusive(async () => {
      for (const item of queue.items) if (item.status === 'error') { item.status = 'pending'; delete item.autoVerify; }
      save(); await sync(Infinity);
    });
    clear.onclick = () => exclusive(async () => {
      if (!confirm('清空本地队列和进度？IMDb 上已经写入的评分及看过记录不会被撤销。')) return;
      for (const item of queue.items) if (item.token) GM_deleteValue(JOB + item.token);
      queue = { source: null, items: [] }; save(); render();
    });
    download.onclick = () => {
      const data = get(STORE, queue);
      const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' }));
      const a = element('a'); a.href = url; a.download = '豆瓣到IMDb-同步记录.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    addEventListener('beforeunload', () => {
      for (const token of activeTokens) {
        const job = get(JOB + token);
        if (job && !terminal(job.state)) put(JOB + token, { ...job, state: 'canceled', note: '豆瓣控制页已关闭或刷新。' });
      }
      if (get(LOCK)?.owner === owner) GM_deleteValue(LOCK);
    });
    render();
  }

  // 仅处理由本脚本生成且在 Tampermonkey 中有对应记录的任务。
  async function imdb() {
    const token = new URLSearchParams(location.hash.slice(1)).get('dbimdb');
    if (!token || !/^[a-zA-Z0-9-]{20,80}$/.test(token)) return;
    const job = get(JOB + token);
    const titleId = location.pathname.match(/^\/title\/(tt\d{5,12})(?:\/|$)/)?.[1];
    if (!job || job.token !== token || job.imdbId !== titleId || Date.now() - job.createdAt > 600000 || terminal(job.state)) return;
    if (!['ratings', 'watched'].includes(job.mode) || !(job.stars === null || Number.isInteger(job.stars) && job.stars >= 1 && job.stars <= 5)) return;
    const body = panel('IMDb 正在接收豆瓣记录');
    element('p', job.title, body);
    const message = element('p', '', body);

    function guard() {
      const current = get(JOB + token);
      const lease = get(LOCK);
      if (!current || terminal(current.state) || lease?.owner !== job.owner || lease.until < Date.now()) throw new Error('任务已停止，请回豆瓣页面重试。');
      if (location.pathname.match(/^\/title\/(tt\d+)/)?.[1] !== job.imdbId) throw new Error('页面影片已改变，停止操作。');
      return current;
    }
    function update(fields) {
      const current = guard();
      put(JOB + token, { ...current, ...fields });
      if (fields.note) message.textContent = fields.note;
    }
    function finish(note, outcome = 'done') { update({ state: 'done', note, outcome }); }
    function waitFor(find, reason, timeout = ACCOUNT_WAIT) {
      // React 更新按钮时立即检查，避免后台页的短轮询被 Chrome 长时间延后。
      return new Promise((resolve, reject) => {
        const end = Date.now() + timeout;
        let observer, poll, timer, settled = false;
        const finishWait = (error, value) => {
          if (settled) return;
          settled = true; observer?.disconnect(); clearInterval(poll); clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const check = () => {
          try {
            guard();
            if (needsAttention()) throw new Error('IMDb 要求登录或验证，请先在页面处理后重试。');
            const value = find();
            if (value) finishWait(null, value);
            else if (Date.now() >= end) finishWait(Object.assign(new Error(reason), { timedOut: true }));
          } catch (error) { finishWait(error); }
        };
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['aria-label', 'aria-disabled', 'aria-pressed', 'aria-busy', 'disabled', 'data-testid'] });
        poll = setInterval(check, 1000); timer = setTimeout(check, timeout); check();
      });
    }
    function accountLoading() {
      // IMDb 的看过按钮可能已显示 Mark as watched，但同一片的账户查询还在 Loading。
      // 只检查本片主区域，不使用推荐影片或演员收藏的加载状态。
      return $$('[data-testid="tm-box-wl-button"], [data-testid="hero-media__poster"] [data-testid^="poster-watchlist-ribbon"]')
        .some(n => visible(n) && (/^loading\b/i.test(n.getAttribute('aria-label') || '') || n.getAttribute('aria-busy') === 'true' ||
          visible($('[data-testid="tm-box-wl-loader"]', n)) || n.classList.contains('ipc-watchlist-ribbon--loading')));
    }
    async function reloadForRetry(field, reason) {
      const current = guard();
      const attempt = Number(current[field] || 0);
      if (attempt >= MAX_RELOADS) return false;
      update({ [field]: attempt + 1, note: `${reason} 正在刷新重试 ${attempt + 1}/${MAX_RELOADS}；不会重复提交。` });
      await sleep(RELOAD_DELAY * (attempt + 1) + Math.floor(Math.random() * RELOAD_DELAY));
      guard(); location.reload(); return true;
    }
    const root = () => $$('[data-testid="hero-rating-bar__user-rating"]').find(visible);
    const rateButton = () => { const r = root(); return r?.matches('button') ? r : r && $('button', r); };
    function readRating() {
      const r = root();
      if (!r) return undefined;
      // 只读取 YOUR RATING 区域，不会将影片平均分识别成个人评分。
      const scoreNode = $('[data-testid="hero-rating-bar__user-rating__score"]', r);
      const explicit = text(scoreNode).match(/^(10|[1-9])(?:\s*\/\s*10)?$/);
      if (explicit) return Number(explicit[1]);
      const value = text(r).match(/(?:^|\D)(10|[1-9])\s*\/\s*10(?:\D|$)/);
      if (value) return Number(value[1]);
      const label = rateButton()?.getAttribute('aria-label') || '';
      const labelled = label.match(/^(?:your rating|you rated|rated|rating)\D{0,8}(10|[1-9])(?:\s*(?:\/|out of)\s*10)?\b/i);
      if (labelled) return Number(labelled[1]);
      // 页面先渲染 Rate 占位，再异步加载账户评分；禁用按钮不等于「未评分」。
      if (!enabled(rateButton()) || accountLoading()) return undefined;
      const unrated = $('[data-testid="hero-rating-bar__user-rating__unrated"]', r);
      if (visible(unrated) || /^(?:your rating\s*)?rate$/i.test(text(r))) return null;
      return undefined;
    }
    function watchedButton() {
      return $$(`button[data-testid="watched-button-${job.imdbId}"]`).find(visible);
    }
    function watchedState() {
      const button = watchedButton();
      if (!enabled(button) || accountLoading() || /^loading\b/i.test(button.getAttribute('aria-label') || '') || visible($('.ipc-loader', button))) return undefined;
      const pressed = button.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'false') return false;
      const label = (button.getAttribute('aria-label') || '').trim();
      if (/^unmark\b.*\bas watched$|^remove\b.*\b(?:watched|watch history)$/i.test(label)) return true;
      if (/^mark\b.*\bas watched$/i.test(label)) return false;
      if (/^(?:marked as )?watched$/i.test(text(button))) return true;
      if (/^mark as watched$/i.test(text(button))) return false;
      return undefined;
    }
    function dialog() {
      return $$('[data-testid="promptable__pc"], [role="dialog"], .ipc-promptable-base__panel').filter(visible)
        .find(node => $('button[aria-label="Rate 1"], .ipc-starbar', node));
    }
    function needsAttention() {
      const header = $('#imdbHeader');
      if (header && $$('a, button', header).some(n => visible(n) && /^(?:sign|log) in$/i.test(text(n)))) return true;
      return $$('[role="dialog"]').some(n => visible(n) && /sign in to|log in to|captcha|verify (?:you|your)|验证码|安全验证/i.test(text(n)));
    }
    function loadingAccountState() {
      return accountLoading() || /^loading\b/i.test(watchedButton()?.getAttribute('aria-label') || '') ||
        /^loading\b/i.test(rateButton()?.getAttribute('aria-label') || '');
    }
    function targetMissing(desired) {
      if (!desired || loadingAccountState()) return false;
      if (desired.kind === 'watched') return watchedState() === false;
      if (desired.kind === 'rating') {
        const value = readRating(); return value === null || typeof value === 'number' && value !== desired.score;
      }
      return false;
    }

    try {
      guard();
      if (needsAttention()) throw new Error('IMDb 要求登录或验证，请先在页面处理后重试。');
      if (job.matchCheck && job.state !== 'verify' && !job.matchedMetadata) {
        update({ state: 'working', note: '正在核对搜索候选的片名、年份、导演与片长……' });
        let candidate;
        try {
          candidate = await waitFor(() => {
            const value = imdbMetadata(document, job.imdbId);
            return value.validIdentity && value.titles.length && (value.years.length || value.directors.length) && value;
          }, 'IMDb 影片资料不足，不能自动核对。', 8000);
        } catch (error) {
          guard();
          update({ state: 'review', note: 'IMDb 影片资料未能可靠核对，请选择候选后手动确认对应关系。' });
          return;
        }
        const evidence = matchEvidence(job.sourceMetadata || {}, candidate);
        if (!evidence.strong) {
          update({ state: 'review', note: `搜索候选需要核对：${evidence.reason}。尚未写入评分或看过状态。`, candidate });
          return;
        }
        update({ note: `已核对匹配：${candidate.titles[0]}；${evidence.reason}`, matchedMetadata: candidate });
      }
      if (job.state === 'verify') {
        message.textContent = '页面已重新加载，正在核验 IMDb 保存的记录……';
        const desired = job.desired;
        if (!desired || !['rating', 'watched'].includes(desired.kind)) throw new Error('核验任务缺少目标信息。');
        try {
          await waitFor(() => desired.kind === 'rating' ? readRating() === desired.score : watchedState() === true,
            '刷新后未确认保存成功。', VERIFY_WAIT);
        } catch (error) {
          guard();
          if (error.timedOut && job.autoRecovery && loadingAccountState() && !needsAttention()) throw error;
          if (error.timedOut && await reloadForRetry('verifyRetries', '保存核验尚未完成。')) return;
          throw new Error('刷新重试后仍未确认保存成功；记录已保留为需处理，没有重复提交。请检查 IMDb 账户资料是否加载成功。');
        }
        finish(desired.kind === 'rating' ? `已刷新确认 IMDb 个人评分 ${desired.score}/10` : '已刷新确认 IMDb 看过状态');
        return;
      }
      update({ state: 'working', note: '等待 IMDb 按钮加载……' });
      if (job.mode === 'ratings' && job.stars !== null) {
        const score = job.stars * 2;
        await waitFor(() => readRating() !== undefined, 'IMDb 账户评分仍在加载或网络请求失败。');
        const current = readRating();
        if (current === score) { finish(`IMDb 已有相同评分 ${score}/10`); return; }
        if (current !== null && !job.overwrite) { finish(`保留 IMDb 原评分 ${current}/10；豆瓣换算为 ${score}/10`, 'kept'); return; }
        const button = await waitFor(() => enabled(rateButton()) && rateButton(), '找不到可用的个人评分按钮。');
        guard(); button.click();
        const modal = await waitFor(dialog, '没有打开评分弹窗；请先登录 IMDb，处理登录/同意提示后重试。');
        const star = await waitFor(() => { const b = $(`button[aria-label="Rate ${score}"]`, modal); return enabled(b) && b; }, '找不到目标星级按钮，请将 IMDb 语言改为 English。');
        // 弹窗再次检查已有评分，以覆盖页面刚加载时个人信息尚未更新的情况。
        const hydratedRating = readRating();
        if (hydratedRating === score) { finish(`IMDb 已有相同评分 ${score}/10（弹窗打开后确认）`); return; }
        if (typeof hydratedRating === 'number' && hydratedRating !== score && !job.overwrite) {
          finish(`保留 IMDb 原评分 ${hydratedRating}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        const initial = text($('.ipc-rating-display__rating', modal));
        if (/^(10|[1-9])$/.test(initial) && Number(initial) !== score && !job.overwrite) {
          finish(`保留 IMDb 弹窗显示的原评分 ${initial}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        if (Number(initial) === score && $$('button', modal).some(b => visible(b) && /^remove rating$/i.test(text(b)))) {
          await waitFor(() => readRating() === score, 'IMDb 弹窗已有相同评分，但个人评分区域尚未确认。请稍后重试。', 10000);
          finish(`IMDb 已有相同评分 ${score}/10（已有评分弹窗确认）`); return;
        }
        guard(); star.click();
        await waitFor(() => text($('.ipc-rating-display__rating', dialog() || modal)) === String(score),
          '评分弹窗没有显示目标分数，已停止提交。');
        const action = await waitFor(() => {
          const saved = readRating();
          if (saved === score) return { kind: 'already' };
          if (typeof saved === 'number' && !job.overwrite) return { kind: 'kept', score: saved };
          const scope = dialog();
          if (!scope) return null;
          const candidates = $$('button.ipc-rating-prompt__rate-button, button[data-testid="rating-prompt__rate-button"]', scope);
          const button = candidates.find(enabled) || $$('button', scope).find(b => enabled(b) && /^rate$/i.test(text(b)));
          return button && { kind: 'submit', button };
        }, '找不到可用的评分提交按钮。');
        if (action.kind === 'already') { finish(`IMDb 已有相同评分 ${score}/10（等待提交期间确认）`); return; }
        if (action.kind === 'kept') { finish(`保留 IMDb 刚加载的原评分 ${action.score}/10；豆瓣换算为 ${score}/10`, 'kept'); return; }
        const latestRating = readRating();
        if (typeof latestRating === 'number' && latestRating !== score && !job.overwrite) {
          finish(`保留 IMDb 刚加载的原评分 ${latestRating}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        // 先记录核验阶段：即使页面没有更新或中途刷新，后续也只读保存状态。
        update({ state: 'verify', desired: { kind: 'rating', score }, note: `正在提交 ${score}/10……` });
        guard(); action.button.click();
        try { await waitFor(() => readRating() === score && !dialog(), '当前页面尚未显示目标评分。', ACK_WAIT); }
        catch (error) { guard(); if (!error.timedOut) throw error; }
        update({ note: '评分请求已发出，刷新页面核验保存结果……' });
      } else {
        await waitFor(() => watchedState() !== undefined, 'IMDb 账户看过状态仍在加载或网络请求失败。');
        if (watchedState() === true) { finish('IMDb 已标记看过'); return; }
        const button = await waitFor(() => enabled(watchedButton()) && watchedButton(), '看过按钮当前不可用。');
        update({ state: 'verify', desired: { kind: 'watched' }, note: '正在标记看过……' });
        guard(); button.click();
        try { await waitFor(() => watchedState() === true, '当前页面尚未显示看过状态。', ACK_WAIT); }
        catch (error) { guard(); if (!error.timedOut) throw error; }
        update({ note: '看过请求已发出，刷新页面核验保存结果……' });
      }
      await sleep(600);
      guard(); location.reload();
    } catch (error) {
      const current = get(JOB + token);
      const attention = needsAttention();
      const recoverable = !!(error.timedOut && current?.autoRecovery && loadingAccountState() && !attention);
      if (!recoverable && !attention && error.timedOut && current && !terminal(current.state) && current.state !== 'verify' && !current.desired) {
        try { if (await reloadForRetry('loadRetries', error.message || 'IMDb 页面未完成加载。')) return; }
        catch (stopped) { error = stopped; }
      }
      const latest = get(JOB + token);
      const errorType = attention ? 'needs-user' : recoverable ? 'account-loading' : targetMissing(latest?.desired) ? 'verification-missing' : 'page-error';
      const note = attention ? 'IMDb 要求登录或验证，请先在页面处理后重试。' : recoverable ? 'IMDb 账户请求暂未恢复；控制页将等待后降速续传，已提交的记录先只读核验。' : error.message || String(error);
      if (latest && !terminal(latest.state)) put(JOB + token, { ...latest, state: 'error', note, errorType, recoverable });
      message.textContent = `已停止：${note} 请保留本页查看问题，回豆瓣页面查看进度。`;
    }
  }

  function boot() {
    if (location.hostname === 'movie.douban.com') douban().catch(console.error);
    if (location.hostname === 'www.imdb.com') imdb().catch(console.error);
  }
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot, { once: true });
})();
