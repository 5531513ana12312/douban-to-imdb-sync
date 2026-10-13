// ==UserScript==
// @name         豆瓣看过 → IMDb（无依赖修复版）
// @namespace    local.douban-imdb.transfer
// @version      2026.10.13.2
// @license      MIT
// @author       Douban to IMDb Sync contributors
// @description  将豆瓣看过顺序同步到 IMDb；支持无评分的看过、断点继续和结果核验。
// @match        https://movie.douban.com/*
// @match        https://www.imdb.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  // Adapted from https://github.com/Adsryen/Douban-to-IMDb
  // Original copyright (c) 2026 Anderson-Ryen. MIT License; see LICENSE.

  // 不依赖 jQuery、string.js 或第三方 CDN；无需提供密码或 Cookie。
  const STORE = 'dbimdb:v1:queue';
  const LOCK = 'dbimdb:v1:lock';
  const JOB = 'dbimdb:v1:job:';
  const WORK_TIMEOUT = 180000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const uuid = () => crypto.randomUUID();
  const get = (key, fallback = null) => GM_getValue(key, fallback);
  const put = (key, value) => GM_setValue(key, value);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const terminal = state => ['done', 'error', 'canceled'].includes(state);
  const statusNames = { pending: '待同步', running: '处理中', done: '已完成', kept: '保留原评分', error: '需处理' };

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
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25000);
    try {
      const response = await fetch(requested.href, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) throw new Error(`豆瓣返回 ${response.status}，请稍后再试。`);
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
    const body = panel('豆瓣看过 → IMDb');
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
    const footer = element('p', '评分按豆瓣 1–5 星 → IMDb 2–10 分转换。不会迁移短评、标签或原观看日期。暂停会完成当前一部后停下。', body);
    footer.className = 'muted';

    let queue = get(STORE, { source: null, items: [] });
    if (!queue || !Array.isArray(queue.items)) queue = { source: null, items: [] };
    let busy = false;
    let stopRequested = false;
    let activeToken = null;
    const owner = uuid();
    let heartbeat;
    const save = () => put(STORE, queue);
    const say = message => { summary.textContent = message; };
    function render(message) {
      const counts = queue.items.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out; }, {});
      say(message || `共 ${queue.items.length} 部 · 已完成 ${counts.done || 0} · 保留 ${counts.kept || 0} · 待处理 ${counts.pending || 0} · 需处理 ${counts.error || 0}`);
      const prioritized = [...queue.items.filter(i => ['error', 'running'].includes(i.status)), ...queue.items.filter(i => !['error', 'running'].includes(i.status))];
      log.textContent = prioritized.slice(0, 70).map(i => `${statusNames[i.status] || i.status} · ${i.title} · ${i.stars ? i.stars + '星' : '无评分'}${i.note ? '\n  ' + i.note : ''}`).join('\n');
      for (const b of [scan, all, pilot, start, retry, clear, mode, overwrite]) b.disabled = busy;
      pause.disabled = !busy;
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
        if (job?.state === 'done') {
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
      busy = true; stopRequested = false; render();
      try { await acquire(); await task(); }
      catch (error) { say(error.message || String(error)); }
      finally {
        busy = false;
        clearInterval(heartbeat);
        if (get(LOCK)?.owner === owner) GM_deleteValue(LOCK);
        for (const b of [scan, all, pilot, start, retry, clear, mode, overwrite]) b.disabled = false;
        pause.disabled = true;
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
        await sleep(2200);
      }
      render(stopRequested ? `已暂停读取，已保存 ${queue.items.length} 部。再次读取全部会自动去重。` : undefined);
    }

    async function sync(limit) {
      const candidates = queue.items.filter(i => i.status === 'pending');
      if (!candidates.length) throw new Error('没有待同步影片。先读取列表；失败项目请点「失败项重试」。');
      const settings = { mode: mode.value, overwrite: overwrite.checked };
      let attempted = 0;
      let missing = 0;
      for (const item of candidates) {
        if (stopRequested || attempted >= limit) break;
        let tab;
        try {
          if (get(LOCK)?.owner !== owner) throw new Error('任务控制权已改变，停止处理。');
          item.status = 'running'; item.note = '正在读取 IMDb 编号'; save(); render();
          if (!item.imdbId) {
            const detailUrl = new URL(`/subject/${item.id}/`, location.origin);
            item.imdbId = imdbIdFrom(await fetchDocument(detailUrl));
          }
          if (!item.imdbId) {
            missing++;
            item.status = 'error'; item.note = '豆瓣详情没有 IMDb 编号，需手动核对影片。'; save();
            render(`已跳过 ${missing} 部缺少 IMDb 编号的影片，继续查找可同步影片……`);
            await sleep(2200); continue;
          }
          attempted++;
          const token = uuid(); activeToken = token; item.token = token;
          put(JOB + token, { token, owner, imdbId: item.imdbId, title: item.title, stars: item.stars,
            ...settings, state: 'pending', createdAt: Date.now() });
          save();
          tab = GM_openInTab(`https://www.imdb.com/title/${item.imdbId}/#dbimdb=${token}`, { active: true, insert: true, setParent: true });
          if (!tab) throw new Error('无法打开 IMDb 标签页，请检查 Tampermonkey 网站访问权限。');
          const deadline = Date.now() + WORK_TIMEOUT;
          let result;
          while (Date.now() < deadline) {
            result = get(JOB + token);
            if (result && terminal(result.state)) break;
            if (tab.closed) throw new Error('IMDb 标签页在确认前被关闭。');
            item.note = result?.note || '等待 IMDb 页面启动；请保持两个网站的标签页打开'; render();
            await sleep(800);
          }
          if (!result || !terminal(result.state)) throw new Error(`IMDb 等待超时；请检查登录、脚本权限或验证提示。最后状态：${result?.note || '页面未启动'}`);
          if (result.state !== 'done') throw new Error(result.note || 'IMDb 处理未完成。');
          item.status = result.outcome === 'kept' ? 'kept' : 'done'; item.note = result.note;
          save(); render();
          tab.close();
        } catch (error) {
          const job = activeToken && get(JOB + activeToken);
          if (job && !terminal(job.state)) put(JOB + activeToken, { ...job, state: 'canceled', note: error.message });
          item.status = 'error'; item.note = error.message || String(error); save();
          stopRequested = true; render('已暂停：' + item.note + ' 修复后点「失败项重试」或「同步待处理」。');
        } finally { activeToken = null; }
        if (!stopRequested) await sleep(2200);
      }
      if (!stopRequested) {
        if (attempted === 0) render(`本次没有写入 IMDb：${missing} 部影片的豆瓣详情均未提供 IMDb 编号。记录已保留，请手动核对对应影片。`);
        else if (limit === 1) render(`已完成 1 部试同步${missing ? `，跳过 ${missing} 部缺少 IMDb 编号的影片` : ''}。请在 IMDb 核对结果后再开始批量同步。`);
        else render();
      }
    }

    scan.onclick = () => exclusive(() => collect(false));
    all.onclick = () => exclusive(() => collect(true));
    pilot.onclick = () => exclusive(async () => {
      if (queue.items.length === 0) await collect(false);
      say('正在查找第一部有 IMDb 编号的待同步影片……');
      await sync(1);
    });
    start.onclick = () => exclusive(() => sync(Infinity));
    pause.onclick = () => { stopRequested = true; say('已请求暂停，当前一部处理完后停止。'); };
    retry.onclick = () => exclusive(async () => {
      for (const item of queue.items) if (item.status === 'error') item.status = 'pending';
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
      if (activeToken) {
        const job = get(JOB + activeToken);
        if (job && !terminal(job.state)) put(JOB + activeToken, { ...job, state: 'canceled', note: '豆瓣控制页已关闭或刷新。' });
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
    async function waitFor(find, reason, timeout = 35000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        guard();
        const value = find();
        if (value) return value;
        await sleep(400);
      }
      throw new Error(reason);
    }
    const root = () => $$('[data-testid="hero-rating-bar__user-rating"]').find(visible);
    const rateButton = () => { const r = root(); return r?.matches('button') ? r : r && $('button', r); };
    function readRating() {
      const r = root();
      if (!r) return undefined;
      // 只读取 YOUR RATING 区域，不会将影片平均分识别成个人评分。
      const value = text(r).match(/\b(10|[1-9])\s*\/\s*10\b/);
      if (value) return Number(value[1]);
      const label = rateButton()?.getAttribute('aria-label') || '';
      const labelled = label.match(/^(?:your rating|you rated|rated|rating)\D{0,8}(10|[1-9])(?:\s*(?:\/|out of)\s*10)?\b/i);
      if (labelled) return Number(labelled[1]);
      const unrated = $('[data-testid="hero-rating-bar__user-rating__unrated"]', r);
      if (visible(unrated) || /^(?:your rating\s*)?rate$/i.test(text(r))) return null;
      return undefined;
    }
    function watchedButton() {
      return $$(`button[data-testid="watched-button-${job.imdbId}"]`).find(visible);
    }
    function watchedState() {
      const button = watchedButton();
      if (!button) return undefined;
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

    try {
      guard();
      if (job.state === 'verify') {
        message.textContent = '页面已重新加载，正在核验 IMDb 保存的记录……';
        const desired = job.desired;
        if (!desired || !['rating', 'watched'].includes(desired.kind)) throw new Error('核验任务缺少目标信息。');
        await waitFor(() => desired.kind === 'rating' ? readRating() === desired.score : watchedState() === true,
          '刷新后未确认保存成功。请检查 IMDb 登录状态和个人记录，再回豆瓣重试。', 45000);
        finish(desired.kind === 'rating' ? `已刷新确认 IMDb 个人评分 ${desired.score}/10` : '已刷新确认 IMDb 看过状态');
        return;
      }
      update({ state: 'working', note: '等待 IMDb 按钮加载……' });
      if (job.mode === 'ratings' && job.stars !== null) {
        const score = job.stars * 2;
        await waitFor(() => readRating() !== undefined, '未识别个人评分区域；请将 IMDb 语言设为 English、检查登录及页面是否加载完成。');
        const current = readRating();
        if (current === score) { finish(`IMDb 已有相同评分 ${score}/10`); return; }
        if (current !== null && !job.overwrite) { finish(`保留 IMDb 原评分 ${current}/10；豆瓣换算为 ${score}/10`, 'kept'); return; }
        const button = await waitFor(() => enabled(rateButton()) && rateButton(), '找不到可用的个人评分按钮。');
        guard(); button.click();
        const modal = await waitFor(dialog, '没有打开评分弹窗；请先登录 IMDb，处理登录/同意提示后重试。');
        const star = await waitFor(() => { const b = $(`button[aria-label="Rate ${score}"]`, modal); return enabled(b) && b; }, '找不到目标星级按钮，请将 IMDb 语言改为 English。');
        // 弹窗再次检查已有评分，以覆盖页面刚加载时个人信息尚未更新的情况。
        const hydratedRating = readRating();
        if (typeof hydratedRating === 'number' && hydratedRating !== score && !job.overwrite) {
          finish(`保留 IMDb 原评分 ${hydratedRating}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        const initial = text($('.ipc-rating-display__rating', modal));
        if (/^(10|[1-9])$/.test(initial) && Number(initial) !== score && !job.overwrite) {
          finish(`保留 IMDb 弹窗显示的原评分 ${initial}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        guard(); star.click();
        await waitFor(() => text($('.ipc-rating-display__rating', dialog() || modal)) === String(score),
          '评分弹窗没有显示目标分数，已停止提交。');
        const submit = await waitFor(() => {
          const scope = dialog();
          if (!scope) return null;
          const candidates = $$('button.ipc-rating-prompt__rate-button, button[data-testid="rating-prompt__rate-button"]', scope);
          return candidates.find(enabled) || $$('button', scope).find(b => enabled(b) && /^rate$/i.test(text(b)));
        }, '找不到可用的评分提交按钮。');
        const latestRating = readRating();
        if (typeof latestRating === 'number' && latestRating !== score && !job.overwrite) {
          finish(`保留 IMDb 刚加载的原评分 ${latestRating}/10；豆瓣换算为 ${score}/10`, 'kept'); return;
        }
        update({ note: `正在提交 ${score}/10……` });
        guard(); submit.click();
        await waitFor(() => readRating() === score && !dialog(), '提交后未确认目标评分。请检查是否要求登录，或手动查看 IMDb 个人评分。');
        update({ state: 'verify', desired: { kind: 'rating', score }, note: '评分已显示，刷新页面核验保存结果……' });
      } else {
        await waitFor(() => watchedState() !== undefined, '未找到本片「Mark as watched」按钮。请将 IMDb 设为 English 并登录；不要使用 Watchlist 代替。');
        if (watchedState() === true) { finish('IMDb 已标记看过'); return; }
        const button = await waitFor(() => enabled(watchedButton()) && watchedButton(), '看过按钮当前不可用。');
        update({ note: '正在标记看过……' });
        guard(); button.click();
        await waitFor(() => watchedState() === true, '未确认看过状态；请完成 IMDb 登录或页面提示后重试。');
        update({ state: 'verify', desired: { kind: 'watched' }, note: '已显示看过，刷新页面核验保存结果……' });
      }
      await sleep(1600);
      guard(); location.reload();
    } catch (error) {
      const current = get(JOB + token);
      if (current && !terminal(current.state)) put(JOB + token, { ...current, state: 'error', note: error.message || String(error) });
      message.textContent = `已停止：${error.message || error} 请保留本页查看问题，回豆瓣页面重试。`;
    }
  }

  function boot() {
    if (location.hostname === 'movie.douban.com') douban().catch(console.error);
    if (location.hostname === 'www.imdb.com') imdb().catch(console.error);
  }
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot, { once: true });
})();
