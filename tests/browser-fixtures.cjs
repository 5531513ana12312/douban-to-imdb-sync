/* Offline regression tests: every HTTP(S) request is fulfilled/aborted locally.
 * Run with a Node installation containing Playwright, or set PLAYWRIGHT_PATH.
 * CHROME_PATH may point to a disposable Chromium/Chrome executable.
 * No real Douban/IMDb account or browser profile is accessed.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const scriptPath = process.env.SCRIPT_PATH || path.join(__dirname, '..', 'douban-to-imdb.user.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const TOKEN = 'regression-fixture-token-123456';
const OWNER = 'regression-fixture-owner';
const ID = 'tt0111161';
const STORE = 'dbimdb:v1:queue';
const LOCK = 'dbimdb:v1:lock';
const JOB = 'dbimdb:v1:job:' + TOKEN;
const results = [];

function makeJob(overrides = {}) {
  return { token: TOKEN, owner: OWNER, imdbId: ID, title: 'Fixture title', stars: 4,
    mode: 'ratings', overwrite: false, state: 'pending', createdAt: Date.now(), ...overrides };
}

function withMetadata(html, values = {}) {
  const entity = { '@context': 'https://schema.org', '@type': 'Movie', url: 'https://www.imdb.com/title/' + ID + '/',
    name: 'Matched Movie', datePublished: '2020-01-01', duration: 'PT1H30M',
    director: [{ '@type': 'Person', name: 'Jane Director' }], ...values };
  return html.replace('</body>', '<script type="application/ld+json">' + JSON.stringify(entity) + '</script></body>');
}

function imdbFixture(config = {}) {
  return `<!doctype html><html><body><h1>Fixture title</h1>
    <div data-testid="hero-rating-bar__aggregate-rating">IMDb RATING 9.3 / 10</div>
    <div id="rating" data-testid="hero-rating-bar__user-rating"></div>
    <button id="otherWatched" data-testid="watched-button-tt9999999" aria-label="Mark Other movie as watched">Mark as watched</button>
    <button id="targetWatched" data-testid="watched-button-${ID}" aria-label="Mark Fixture title as watched">Mark as watched</button>
    <button id="watchlist" aria-pressed="false">Add to Watchlist</button>
    <script>
    const config = ${JSON.stringify(config)};
    const read = (k, d) => JSON.parse(localStorage.getItem('fixture:' + k) ?? JSON.stringify(d));
    const write = (k, v) => localStorage.setItem('fixture:' + k, JSON.stringify(v));
    const count = k => write(k, read(k, 0) + 1);
    count('loads');
    if (read('loads', 0) === 1) {
      write('rating', config.initialRating ?? null);
      write('watched', !!config.initialWatched);
    }
    const ratingRoot = document.getElementById('rating');
    function renderRating(value) {
      ratingRoot.textContent = config.compactMarkup ? 'YOUR RATING' : 'YOUR RATING ';
      const button = document.createElement('button');
      button.setAttribute('aria-label', value === null ? 'Rate Fixture title' : 'Your rating ' + value + ' out of 10');
      if (config.omitRatingLabel) button.removeAttribute('aria-label');
      const span = document.createElement('span');
      span.textContent = value === null ? 'Rate' : config.compactMarkup ? value + '/10' : value + ' / 10';
      if (value === null) span.dataset.testid = 'hero-rating-bar__user-rating__unrated';
      else if (config.compactMarkup) span.dataset.testid = 'hero-rating-bar__user-rating__score';
      button.append(span); ratingRoot.append(button); button.onclick = openRating;
    }
    function openRating() {
      count('opens');
      if (document.getElementById('watchlist').getAttribute('aria-label') === 'Loading') count('prematurePrompts');
      if (config.hydrateOnOpen) renderRating(read('rating', null));
      if (config.hydrateAfterOpen) setTimeout(() => renderRating(read('rating', null)), config.hydrateAfterOpen);
      const modal = document.createElement('div'); modal.dataset.testid = 'promptable__pc';
      modal.innerHTML = '<div class="ipc-rating-display__rating"></div><div class="ipc-starbar"></div><button class="ipc-rating-prompt__rate-button" disabled aria-disabled="true">Rate</button>';
      const display = modal.querySelector('.ipc-rating-display__rating');
      display.textContent = String(config.initialDialogRating ?? read('rating', null) ?? '?');
      const submit = modal.querySelector('.ipc-rating-prompt__rate-button');
      if (read('rating', null) !== null) {
        const remove = document.createElement('button'); remove.textContent = 'Remove rating'; modal.append(remove);
      }
      let selected = null;
      for (let n = 1; n <= 10; n++) {
        const b = document.createElement('button'); b.className = 'ipc-starbar__rating__button'; b.setAttribute('aria-label', 'Rate ' + n); b.textContent = String(n);
        b.onclick = () => {
          count('starClicks'); selected = n; write('selected', n);
          if (!config.ignoreSelection) display.textContent = String(n);
          submit.disabled = !!config.disableUnchangedRating && read('rating', null) === selected;
          submit.setAttribute('aria-disabled', String(submit.disabled));
          if (config.hydrateOnStar) renderRating(read('rating', null));
          if (config.cancelOnStar) {
            const lease = JSON.parse(localStorage.getItem('gm:${LOCK}'));
            lease.until = Date.now() - 1; localStorage.setItem('gm:${LOCK}', JSON.stringify(lease));
          }
        };
        modal.querySelector('.ipc-starbar').append(b);
      }
      submit.onclick = () => {
        write('jobAtSubmit', window.GM_getValue('${JOB}'));
        count('submits'); write('submittedScore', selected);
        if (config.persistRating !== false) write('rating', selected);
        if (!config.staleAfterSubmit) { renderRating(selected); modal.remove(); }
      };
      document.body.append(modal);
    }
    const target = document.getElementById('targetWatched');
    function renderWatched(value) {
      target.textContent = value ? 'Watched' : 'Mark as watched';
      target.setAttribute('aria-label', value ? 'Unmark Fixture title as watched' : 'Mark Fixture title as watched');
    }
    target.onclick = () => {
      write('jobAtSubmit', window.GM_getValue('${JOB}'));
      count('watchedClicks');
      if (document.getElementById('watchlist').getAttribute('aria-label') === 'Loading') count('prematureClicks');
      if (config.persistWatched !== false) write('watched', true);
      if (!config.staleAfterSubmit) renderWatched(true);
    };
    document.getElementById('otherWatched').onclick = () => count('otherWatchedClicks');
    document.getElementById('watchlist').onclick = () => count('watchlistClicks');
    renderRating(read('loads', 0) === 1 && config.staleUnrated ? null : read('rating', null));
    if (config.loadingRatingMs) {
      renderRating(null);
      const loading = ratingRoot.querySelector('button'); loading.disabled = true; loading.setAttribute('aria-disabled', 'true'); loading.setAttribute('aria-label', 'Loading rating');
      setTimeout(() => renderRating(read('rating', null)), config.loadingRatingMs);
    }
    renderWatched(read('watched', false));
    const primary = document.getElementById('watchlist');
    if (config.accountLoadingMs || config.failAccountLoads) {
      primary.dataset.testid = 'tm-box-wl-button'; primary.setAttribute('aria-label', 'Loading');
      primary.innerHTML = '<div data-testid="tm-box-wl-loader"><svg class="ipc-loader"></svg></div>';
      renderRating(null); renderWatched(false);
      if (read('loads', 0) > (config.failAccountLoads || 0)) setTimeout(() => {
        primary.innerHTML = 'Add to Watchlist'; primary.removeAttribute('aria-label');
        renderRating(read('rating', null)); renderWatched(read('watched', false));
      }, config.accountLoadingMs || 20);
    }
    </script></body></html>`;
}

async function fixture(browser, { html, url = 'https://www.imdb.com/title/' + ID + '/#dbimdb=' + TOKEN, job, seed = {}, pages = {}, workers = null, searches = {}, fastRecovery = false, holdRecovery = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const errors = [];
  const requests = [];
  await context.route('**/*', async route => {
    const request = route.request(); requests.push(request.url());
    const u = new URL(request.url());
    if (request.resourceType() === 'document' || pages[u.pathname + u.search] || pages[u.pathname]) {
      const payload = pages[u.pathname + u.search] || pages[u.pathname] || html;
      await route.fulfill({ status: typeof payload === 'object' ? payload.status : 200, contentType: 'text/html; charset=utf-8', body: typeof payload === 'object' ? payload.body : payload });
    } else await route.abort();
  });
  const storage = { ...seed };
  if (job) {
    storage[JOB] = job;
    storage[LOCK] = { owner: OWNER, until: Date.now() + 240000 };
  }
  await context.addInitScript(({ storage, source, workers, searches }) => {
    if (!localStorage.getItem('fixture:initialized')) {
      Object.entries(storage).forEach(([k, v]) => localStorage.setItem('gm:' + k, JSON.stringify(v)));
      localStorage.setItem('fixture:initialized', 'true');
    }
    window.GM_getValue = (key, fallback) => { const v = localStorage.getItem('gm:' + key); return v === null ? fallback : JSON.parse(v); };
    window.GM_setValue = (key, value) => {
      localStorage.setItem('gm:' + key, JSON.stringify(value));
      if (key.startsWith('dbimdb:v1:job:')) {
        const history = JSON.parse(localStorage.getItem('fixture:jobHistory') || '[]');
        history.push({ state: value.state, note: value.note, desired: value.desired });
        localStorage.setItem('fixture:jobHistory', JSON.stringify(history));
      }
    };
    window.GM_deleteValue = key => localStorage.removeItem('gm:' + key);
    window.GM_registerMenuCommand = (name, callback) => { window.fixtureMenu = { name, callback }; };
    window.GM_xmlhttpRequest = details => {
      const query = decodeURIComponent(new URL(details.url).pathname.split('/').at(-1).replace(/\.json$/, ''));
      const calls = JSON.parse(localStorage.getItem('fixture:searches') || '[]');
      calls.push({ query, anonymous: details.anonymous });
      localStorage.setItem('fixture:searches', JSON.stringify(calls));
      const values = searches[query] || [];
      setTimeout(() => details.onload({ status: values.status || 200, responseText: JSON.stringify({ d: Array.isArray(values) ? values : values.values || [] }) }), 20);
      return { abort() {} };
    };
    const workerEvents = [];
    let workerIndex = 0, activeWorkers = 0, maxActiveWorkers = 0;
    const recordWorkerEvent = event => {
      workerEvents.push(event);
      localStorage.setItem('fixture:workerEvents', JSON.stringify(workerEvents));
      localStorage.setItem('fixture:maxActiveWorkers', JSON.stringify(maxActiveWorkers));
    };
    window.GM_openInTab = (url, options) => {
      if (!workers) throw new Error('Unexpected tab opening during this fixture: ' + url);
      const token = new URLSearchParams(new URL(url).hash.slice(1)).get('dbimdb');
      const key = 'dbimdb:v1:job:' + token;
      const index = workerIndex++, config = workers[index] || {};
      activeWorkers++; maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      recordWorkerEvent({ type: 'open', index, url, token, at: Date.now(), active: options?.active,
        job: window.GM_getValue(key) });
      const tab = {
        closed: false,
        close() { if (!this.closed) { this.closed = true; activeWorkers--; recordWorkerEvent({ type: 'close', index }); } }
      };
      setTimeout(() => {
        if (config.result === 'closed') { tab.close(); return; }
        const current = window.GM_getValue(key);
        const state = ['error', 'temporary', 'missing'].includes(config.result) ? 'error' : 'done';
        window.GM_setValue(key, { ...current, ...(config.desired ? { desired: config.desired } : {}), state, outcome: 'done',
          recoverable: config.result === 'temporary', errorType: config.result === 'temporary' ? 'account-loading' : config.result === 'missing' ? 'verification-missing' : 'page-error',
          note: state === 'done' ? 'fixture persisted and verified' : 'fixture worker failure' });
        recordWorkerEvent({ type: 'result', index, state });
      }, config.delay ?? 100);
      return tab;
    };
    window.eval(source);
  }, { storage, source: fastRecovery ? source.replace('const ACCOUNT_WAIT = 15000;', 'const ACCOUNT_WAIT = 400;')
    .replace('const VERIFY_WAIT = 20000;', 'const VERIFY_WAIT = 500;').replace('const ACK_WAIT = 4000;', 'const ACK_WAIT = 250;')
    .replace('const RELOAD_DELAY = 1500;', 'const RELOAD_DELAY = 10;')
    .replace('const RECOVERY_WAIT = 30000;', holdRecovery ? 'const RECOVERY_WAIT = 1200;' : 'const RECOVERY_WAIT = 80;')
    .replace('const BATCH_SIZE = 30;', 'const BATCH_SIZE = 3;').replace('const BATCH_WAIT = 20000;', 'const BATCH_WAIT = 500;') : source, workers, searches });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return {
    context, page, errors, requests,
    async read(key) { return page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key); },
    async job() { return this.read('gm:' + JOB); },
    async waitState(state, timeout = 9000) { await page.waitForFunction(({ key, state }) => JSON.parse(localStorage.getItem('gm:' + key) || 'null')?.state === state, { key: JOB, state }, { timeout }); },
    async finish() { assert.deepEqual(errors, [], 'uncaught browser errors'); await context.close(); }
  };
}

async function test(name, fn) {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  const started = Date.now();
  try { await fn(); results.push({ name, result: 'PASS', ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, result: 'FAIL', ms: Date.now() - started, error: error.stack }); console.error('FAIL ' + name + '\n' + error.stack); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    await test('Douban panel boots without any CDN or external script and survives hostile page CSS', async () => {
      const f = await fixture(browser, { url: 'https://movie.douban.com/', html: '<!doctype html><style>button{display:none}h2{color:red}</style><body>Douban home</body>' });
      await f.page.getByRole('button', { name: '读取本页', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await f.page.locator('#dbimdb-helper').count(), 1);
      assert.equal(await f.page.evaluate(() => typeof window.fixtureMenu.callback), 'function');
      assert.equal(f.requests.length, 1);
      await f.page.getByRole('button', { name: '读取本页', exact: true }).click();
      await f.page.getByText('请先打开豆瓣电影', { exact: false }).waitFor();
      await f.finish();
    });

    await test('Collect parses all five star values, keeps unrated films, uses text safely and deduplicates rereads', async () => {
      const items = [1, 2, 3, 4, 5, null].map((stars, i) => `<div class="item"><div class="info"><div class="title"><a href="https://movie.douban.com/subject/${10001 + i}/">${i === 0 ? '&lt;img src=x onerror=alert(1)&gt;' : 'Movie ' + i}</a></div>${stars ? '<span class="extra rating' + stars + '-t other"></span>' : ''}<span class="date">2020-01-0${i + 1}</span></div></div>`).join('');
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect/', html: '<!doctype html><body><div class="grid-view">' + items + '</div></body>' });
      await f.page.getByRole('button', { name: '读取本页', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key) || '{}').items?.length === 6, STORE);
      const queue = await f.read('gm:' + STORE);
      assert.equal(queue.source, '/people/test-user/collect');
      assert.deepEqual(queue.items.map(i => i.stars), [1, 2, 3, 4, 5, null]);
      assert.equal(queue.items[0].title, '<img src=x onerror=alert(1)>');
      assert.equal(queue.items[5].date, '2020-01-06');
      assert.equal(await f.page.locator('#dbimdb-helper img').count(), 0);
      await f.page.getByRole('button', { name: '读取本页', exact: true }).click();
      await f.page.getByText('共 6 部', { exact: false }).waitFor();
      assert.equal((await f.read('gm:' + STORE)).items.length, 6);
      await f.finish();
    });

    await test('Pilot reads an empty queue, skips a title without IMDb ID and tests exactly one eligible film', async () => {
      const list = '<!doctype html><body><div class="grid-view">' + [60001, 60002, 60003].map(id => '<div class="item"><div class="info"><div class="title"><a href="/subject/' + id + '/">Movie ' + id + '</a></div><span class="rating4-t"></span></div></div>').join('') + '</div></body>';
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: list,
        pages: {
          '/subject/60001/': '<!doctype html><div id="info">Director: Someone</div>',
          '/subject/60002/': '<!doctype html><div id="info">IMDb: tt0111161</div>',
          '/subject/60003/': '<!doctype html><div id="info">IMDb: tt9999999</div>'
        }, workers: [{ result: 'done' }] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.getByText('已完成 1 部试同步，另有 1 部待核对', { exact: false }).waitFor({ timeout: 12000 });
      const queue = await f.read('gm:' + STORE);
      assert.deepEqual(queue.items.map(item => item.status), ['review', 'done', 'pending']);
      const opens = (await f.read('fixture:workerEvents')).filter(event => event.type === 'open');
      assert.equal(opens.length, 1);
      assert.ok(opens[0].url.includes('/title/tt0111161/'));
      await f.finish();
    });

    await test('Pilot explicitly reports no IMDb write when all available titles lack IDs', async () => {
      const list = '<!doctype html><body><div class="grid-view"><div class="item"><div class="info"><div class="title"><a href="/subject/60004/">Unmatched movie</a></div></div></div></div></body>';
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: list,
        pages: { '/subject/60004/': '<!doctype html><div id="info">No external identifier</div>' }, workers: [] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.getByText('本次没有写入 IMDb：1 部需要核对', { exact: false }).waitFor({ timeout: 8000 });
      assert.equal((await f.read('gm:' + STORE)).items[0].status, 'review');
      assert.equal(await f.read('fixture:workerEvents'), null);
      await f.finish();
    });

    await test('All-page collection starts without filters, follows pagination, and deduplicates overlapping pages and repeat scans', async () => {
      const list = (ids, next) => '<!doctype html><body><div class="grid-view">' + ids.map(id => '<div class="item"><div class="info"><div class="title"><a href="/subject/' + id + '/">Movie ' + id + '</a></div><span class="rating4-t"></span></div></div>').join('') + '</div>' + (next ? '<div class="paginator"><span class="next"><a href="' + next + '">next</a></span></div>' : '') + '</body>';
      const first = '/people/test-user/collect?start=0&sort=time&rating=all&filter=all&mode=grid';
      const second = '/people/test-user/collect?start=2';
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect?start=99&rating=5', html: list([19999]), pages: { [first]: list([10001, 10002], second), [second]: list([10002, 10003]) } });
      for (let run = 0; run < 2; run++) {
        await f.page.getByRole('button', { name: '读取全部看过', exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
        assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.id), ['10001', '10002', '10003']);
      }
      assert.equal(f.requests.filter(u => u.endsWith(first)).length, 2);
      assert.equal(f.requests.filter(u => u.endsWith(second)).length, 2);
      await f.finish();
    });

    await test('Controller processes one worker at a time, pauses after the current film, and resumes only pending films', async () => {
      const items = [10001, 10002, 10003].map((id, i) => ({ id: String(id), title: 'Movie ' + id, url: 'https://movie.douban.com/subject/' + id + '/', stars: 4, date: '', imdbId: 'tt011116' + (i + 1), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<!doctype html><body>Controller fixture</body>', seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: [{ delay: 1200 }, {}, {}] });
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('1');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture:workerEvents') || '[]').some(e => e.type === 'open'));
      await f.page.getByRole('button', { name: '暂停', exact: true }).click();
      await f.page.waitForFunction(key => { const q = JSON.parse(localStorage.getItem('gm:' + key)); return q.items[0].status === 'done' && !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled; }, STORE);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['done', 'pending', 'pending']);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('1');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items.every(i => i.status === 'done'), STORE, { timeout: 12000 });
      const events = await f.read('fixture:workerEvents');
      assert.deepEqual(events.filter(e => e.type === 'open').map(e => new URL(e.url).pathname), ['/title/tt0111161/', '/title/tt0111162/', '/title/tt0111163/']);
      assert.equal(events.filter(e => e.type === 'close').length, 3);
      assert.equal(await f.read('fixture:maxActiveWorkers'), 1);
      await f.finish();
    });

    await test('Controller stops on worker failure or early tab closure and never marks the film successful', async () => {
      for (const result of ['error', 'closed']) {
        const items = [10001, 10002].map((id, i) => ({ id: String(id), title: 'Movie ' + id, stars: null, imdbId: 'tt011116' + (i + 1), status: 'pending', note: '' }));
        const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<!doctype html><body>Controller failure fixture</body>', seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: [{ result }] });
        await f.page.getByLabel('同步速度', { exact: true }).selectOption('1');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
        await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'error', STORE);
        const queue = await f.read('gm:' + STORE);
        assert.deepEqual(queue.items.map(i => i.status), ['error', 'pending']);
        const events = await f.read('fixture:workerEvents');
        assert.equal(events.filter(e => e.type === 'open').length, 1);
        const worker = await f.read('gm:dbimdb:v1:job:' + events[0].token);
        assert.equal(worker.state, result === 'error' ? 'error' : 'canceled');
        assert.match(queue.items[0].note, result === 'error' ? /fixture worker failure/ : /确认前被关闭/);
        await f.finish();
      }
    });

    await test('Temporary account failure closes the failed tab and resumes serially after a cooldown', async () => {
      const items = [65001, 65002, 65003].map((id, i) => ({ id: String(id), title: 'Recovery ' + id, stars: null,
        imdbId: 'tt' + String(5500000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Recovery</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, fastRecovery: true,
        workers: [{ result: 'temporary', delay: 20 }, {}, {}, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items.every(i => i.status === 'done'), STORE);
      const events = await f.read('fixture:workerEvents'), opens = events.filter(e => e.type === 'open');
      assert.equal(opens.length, 4);
      assert.equal(opens[0].url.split('/#')[0], opens[1].url.split('/#')[0]);
      assert.equal(events.filter(e => e.type === 'close').length, 4);
      await f.page.getByText('当前并行 1 部', { exact: false }).waitFor();
      assert.ok(opens.every(e => e.job.autoRecovery));
      await f.finish();
    });

    await test('Automatic recovery preserves uncertain write intent and opens the next job as verify-only', async () => {
      const item = { id: '65004', title: 'Uncertain watched', stars: null, imdbId: ID, status: 'pending', note: '' };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Verify recovery</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } }, fastRecovery: true,
        workers: [{ result: 'temporary', desired: { kind: 'watched' }, delay: 20 }, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'done', STORE);
      const opened = (await f.read('fixture:workerEvents')).filter(e => e.type === 'open');
      assert.equal(opened.length, 2);
      assert.equal(opened[1].job.state, 'verify');
      assert.deepEqual(opened[1].job.desired, { kind: 'watched' });
      assert.equal((await f.read('gm:' + STORE)).items[0].autoVerify, undefined);
      await f.finish();
    });

    await test('User pause during recovery stops new pages and retains pending read-only intent across reload', async () => {
      const item = { id: '65005', title: 'Pause recovery', stars: null, imdbId: ID, status: 'pending', note: '' };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Pause recovery</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } }, fastRecovery: true, holdRecovery: true,
        workers: [{ result: 'temporary', desired: { kind: 'watched' }, delay: 20 }, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.getByText('自动恢复 1/3', { exact: false }).waitFor();
      await f.page.getByRole('button', { name: '暂停', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
      await f.page.reload();
      const current = (await f.read('gm:' + STORE)).items[0];
      assert.equal(current.status, 'pending');
      assert.deepEqual(current.autoVerify, { kind: 'watched' });
      await f.finish();
    });

    await test('Continuous account outage stops after three controller recoveries and keeps unconfirmed records', async () => {
      const items = [65006, 65007].map((id, i) => ({ id: String(id), title: 'Outage ' + i, stars: null,
        imdbId: 'tt' + String(5600000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Continuous outage</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, fastRecovery: true,
        workers: Array.from({ length: 4 }, () => ({ result: 'temporary', delay: 20, desired: { kind: 'watched' } })) });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      const queue = await f.read('gm:' + STORE);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 4);
      assert.deepEqual(queue.items.map(i => i.status), ['error', 'pending']);
      assert.deepEqual(queue.items[0].autoVerify, { kind: 'watched' });
      await f.page.getByText('IMDb 连续恢复失败', { exact: false }).waitFor();
      await f.finish();
    });

    await test('Explicit negative verification retains the failed film without blocking healthy pending titles', async () => {
      const items = [65008, 65009].map((id, i) => ({ id: String(id), title: 'Missing save ' + i, stars: null,
        imdbId: 'tt' + String(5700000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Missing save</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, fastRecovery: true,
        workers: [{ result: 'missing', desired: { kind: 'watched' }, delay: 20 }, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['error', 'done']);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 2);
      await f.finish();
    });

    await test('Batch pacing rests after its page budget and resumes all remaining pending records', async () => {
      const items = Array.from({ length: 5 }, (_, i) => ({ id: String(65100 + i), title: 'Rest ' + i, stars: 4,
        imdbId: 'tt' + String(5800000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Batch rest</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, fastRecovery: true, workers: items.map(() => ({})) });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.getByText('稳速休息', { exact: false }).waitFor();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items.every(i => i.status === 'done'), STORE);
      const events = await f.read('fixture:workerEvents'), opens = events.filter(e => e.type === 'open');
      const thirdClose = events.find(e => e.type === 'close' && e.index === 2);
      assert.equal(opens.length, 5);
      assert.ok(events.indexOf(thirdClose) < events.indexOf(opens[3]), 'page budget drains before resuming');
      await f.finish();
    });

    await test('Automatic network recovery can be disabled without changing the original queue', async () => {
      const item = { id: '65010', title: 'Manual recovery', stars: null, imdbId: ID, status: 'pending', note: '' };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Disable recovery</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } }, fastRecovery: true, workers: [{ result: 'temporary' }, {}] });
      await f.page.getByLabel('自动稳速：', { exact: false }).uncheck();
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.equal((await f.read('gm:' + STORE)).items[0].status, 'error');
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
      assert.equal(await f.read('gm:dbimdb:v5:autoResume'), false);
      await f.finish();
    });

    await test('Fast mode runs at most two titles and pause finishes only the current two', async () => {
      const items = [10001, 10002, 10003].map((id, i) => ({ id: String(id), title: 'Movie ' + id, stars: 4, imdbId: 'tt011116' + (i + 1), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Fast mode</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: [{ delay: 800 }, { delay: 800 }, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture:workerEvents') || '[]').filter(e => e.type === 'open').length === 2);
      await f.page.getByRole('button', { name: '暂停', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['done', 'done', 'pending']);
      assert.equal(await f.read('fixture:maxActiveWorkers'), 2);
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items.every(i => i.status === 'done'), STORE);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 3);
      await f.finish();
    });

    await test('Fast mode serializes two Douban records pointing to the same IMDb title', async () => {
      const items = [10001, 10002].map(id => ({ id: String(id), title: 'Movie ' + id, stars: 4, imdbId: ID, status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Duplicate target</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: [{ delay: 700 }, {}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items.every(i => i.status === 'done'), STORE);
      assert.equal(await f.read('fixture:maxActiveWorkers'), 1);
      await f.finish();
    });

    await test('Ten workers obey the selected cap and pause cancels queued new pages', async () => {
      const items = Array.from({ length: 24 }, (_, i) => ({ id: String(61000 + i), title: 'Parallel ' + i,
        stars: 4, imdbId: 'tt' + String(5000000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Ten workers</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: items.map(() => ({ delay: 5000 })) });
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('10');
      assert.equal(await f.read('gm:dbimdb:v3:parallel'), 10);
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture:workerEvents') || '[]').filter(e => e.type === 'open').length === 10);
      await f.page.getByRole('button', { name: '暂停', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled, null, { timeout: 15000 });
      const queue = await f.read('gm:' + STORE);
      assert.equal(queue.items.filter(i => i.status === 'done').length, 10);
      assert.equal(queue.items.filter(i => i.status === 'pending').length, 14);
      assert.equal(await f.read('fixture:maxActiveWorkers'), 10);
      const opened = (await f.read('fixture:workerEvents')).filter(e => e.type === 'open');
      assert.equal(opened.length, 10);
      assert.ok(opened.every(e => e.active === false), 'workers open in background');
      assert.ok(opened.slice(1).every((e, i) => e.at - opened[i].at >= 350), 'actual launch pacing');
      await f.page.getByText('已确认 10 部', { exact: false }).waitFor();
      await f.page.reload();
      assert.equal(await f.page.getByLabel('同步速度', { exact: true }).inputValue(), '10');
      await f.finish();
    });

    await test('Sixteen-worker failure prevents all reserved page openings and preserves pending queue', async () => {
      const items = Array.from({ length: 24 }, (_, i) => ({ id: String(62000 + i), title: 'Failure ' + i,
        stars: 4, imdbId: 'tt' + String(5100000 + i), status: 'pending', note: '' }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Sixteen failure</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, workers: [{ result: 'error', delay: 50 }] });
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('16');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
      const queue = await f.read('gm:' + STORE);
      assert.equal(queue.items.filter(i => i.status === 'error').length, 1);
      assert.equal(queue.items.filter(i => i.status === 'pending').length, 23);
      await f.finish();
    });

    await test('Missing Douban ID is searched by English alias and handed off with mandatory metadata verification', async () => {
      const item = { id: '60020', title: '中文片名', stars: 4, status: 'pending', imdbId: null, note: '' };
      const detail = '<body><h1><span property="v:itemreviewed">中文片名</span><span class="year">(2020)</span></h1><div id="info">又名: Matched Movie\n片长: 90分钟</div><script type="application/ld+json">' + JSON.stringify({ '@type': 'Movie', name: '中文片名', director: [{ name: 'Jane Director' }], datePublished: '2020-01-01' }) + '</script></body>';
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Search coordinator</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } }, pages: { '/subject/60020/': detail },
        searches: { 'Matched Movie': [{ id: ID, l: 'Matched Movie', y: 2020, qid: 'movie' }] }, workers: [{}] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'done', STORE);
      const event = (await f.read('fixture:workerEvents')).find(e => e.type === 'open');
      const job = await f.read('gm:dbimdb:v1:job:' + event.token);
      assert.equal(job.imdbId, ID); assert.equal(job.matchCheck, true);
      assert.ok(job.sourceMetadata.titles.includes('Matched Movie'));
      assert.deepEqual(job.sourceMetadata.years, [2020]);
      assert.ok((await f.read('fixture:searches')).every(v => v.anonymous === true));
      await f.finish();
    });

    await test('An English-only suggestion can be inspected for its Japanese original title before writing', async () => {
      const item = { id: '60026', title: '日本語の作品', stars: 4, status: 'pending', imdbId: null,
        metadata: { titles: ['日本語の作品'], years: [2020], directors: [], fetchedAt: Date.now() } };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Original title</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } },
        searches: { '日本語の作品': [{ id: ID, l: 'English Release Title', y: 2020 }] }, workers: [{}] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'done', STORE);
      const event = (await f.read('fixture:workerEvents')).find(e => e.type === 'open');
      assert.equal((await f.read('gm:dbimdb:v1:job:' + event.token)).matchCheck, true);
      await f.finish();

      const next = { props: { pageProps: { aboveTheFoldData: { id: ID, titleText: { text: 'English Release Title' }, originalTitleText: { text: '日本語の作品' }, releaseYear: { year: 2020 } } } } };
      const html = withMetadata(imdbFixture(), { name: 'English Release Title', datePublished: undefined })
        .replace('</body>', '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(next) + '</script></body>');
      const worker = await fixture(browser, { html, job: makeJob({ matchCheck: true, sourceMetadata: item.metadata }) });
      await worker.waitState('done');
      assert.equal(await worker.read('fixture:submits'), 1);
      await worker.finish();
    });

    await test('Same-name result from another year stays reviewable and is never automatically rated', async () => {
      const item = { id: '60021', title: 'Diary Without Words 2014', stars: 4, status: 'pending', imdbId: null, note: '',
        metadata: { titles: ['Diary Without Words 2014', 'Diary Without Words'], years: [2014], directors: ['Sho Miyake'], fetchedAt: Date.now() } };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Different year</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } },
        searches: { 'Diary Without Words 2014': [{ id: ID, l: 'Diary Without Words', y: 2018 }], 'Diary Without Words': [{ id: ID, l: 'Diary Without Words', y: 2018 }] }, workers: [] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'review', STORE);
      assert.equal(await f.read('fixture:workerEvents'), null);
      assert.equal((await f.read('gm:' + STORE)).items[0].candidates[0].id, ID);
      await f.finish();
    });

    await test('Ambiguous same-title same-year search presents candidates for explicit choice', async () => {
      const item = { id: '60022', title: 'Matched Movie', stars: 4, status: 'pending', imdbId: null, note: '',
        metadata: { titles: ['Matched Movie'], years: [2020], directors: [], fetchedAt: Date.now() } };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Ambiguous match</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } },
        searches: { 'Matched Movie': [{ id: ID, l: 'Matched Movie', y: 2020 }, { id: 'tt9999999', l: 'Matched Movie', y: 2020 }] }, workers: [{}] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).waitFor();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.equal((await f.read('gm:' + STORE)).items[0].status, 'review');
      assert.equal(await f.read('fixture:workerEvents'), null);
      await f.page.getByText('Matched Movie', { exact: true }).last().click();
      await f.page.getByRole('button', { name: '选用此条目', exact: true }).first().click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'pending', STORE);
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key)).items[0].status === 'done', STORE);
      const event = (await f.read('fixture:workerEvents')).find(e => e.type === 'open');
      assert.equal((await f.read('gm:dbimdb:v1:job:' + event.token)).matchCheck, false);
      await f.finish();
    });

    await test('Search results are cached across retry runs', async () => {
      const item = { id: '60023', title: 'Uncatalogued Movie', stars: null, status: 'pending', imdbId: null, note: '',
        metadata: { titles: ['Uncatalogued Movie'], years: [2020], directors: [], fetchedAt: Date.now() } };
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Search cache</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items: [item] } }, searches: {}, workers: [] });
      await f.page.getByRole('button', { name: '先试 1 部', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      await f.page.getByText('Uncatalogued Movie', { exact: true }).last().click();
      await f.page.getByLabel('重新搜索 Uncatalogued Movie', { exact: true }).fill('Uncatalogued Movie');
      await f.page.getByRole('button', { name: '搜索名称', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.equal((await f.read('fixture:searches')).length, 1);
      await f.finish();
    });

    await test('Search 429 pauses the queue instead of hammering IMDb', async () => {
      const items = [60024, 60025].map(id => ({ id: String(id), title: 'Matched Movie', stars: 4, status: 'pending', imdbId: null,
        metadata: { titles: ['Matched Movie'], years: [2020], directors: [], fetchedAt: Date.now() } }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Rate limit</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, searches: { 'Matched Movie': { status: 429 } }, workers: [] });
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('1');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['error', 'pending']);
      assert.equal((await f.read('fixture:searches')).length, 1);
      await f.finish();
    });

    await test('Search 429 with sixteen workers cancels queued search requests after the first response', async () => {
      const items = Array.from({ length: 20 }, (_, i) => ({ id: String(63000 + i), title: 'Matched Movie', stars: 4,
        status: 'pending', note: '', imdbId: null, metadata: { titles: ['Matched Movie'], years: [2020],
          directors: [], fetchedAt: Date.now() } }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>Parallel rate limit</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, searches: { 'Matched Movie': { status: 429 } }, workers: [] });
      await f.page.getByLabel('同步速度', { exact: true }).selectOption('16');
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      const queue = await f.read('gm:' + STORE);
      assert.equal(queue.items.filter(i => i.status === 'error').length, 1);
      assert.equal(queue.items.filter(i => i.status === 'pending').length, 19);
      assert.equal((await f.read('fixture:searches')).length, 1);
      assert.equal(await f.read('fixture:workerEvents'), null);
      await f.finish();
    });

    await test('Verified search metadata permits the actual rating operation and refresh verification', async () => {
      const f = await fixture(browser, { html: withMetadata(imdbFixture()), job: makeJob({ matchCheck: true,
        sourceMetadata: { titles: ['Matched Movie'], years: [2020], directors: ['Jane Director'], duration: 90 } }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:submits'), 1);
      assert.equal(await f.read('fixture:rating'), 8);
      await f.finish();
    });

    await test('Different director or duration rejects a searched match without touching account controls', async () => {
      for (const values of [{ director: [{ name: 'Other Director' }] }, { duration: 'PT3H' }]) {
        const f = await fixture(browser, { html: withMetadata(imdbFixture(), values), job: makeJob({ matchCheck: true,
          sourceMetadata: { titles: ['Matched Movie'], years: [2020], directors: ['Jane Director'], duration: 90 } }) });
        await f.waitState('review');
        assert.equal(await f.read('fixture:opens'), null);
        assert.equal(await f.read('fixture:submits'), null);
        assert.equal(await f.read('fixture:watchedClicks'), null);
        await f.finish();
      }
    });

    await test('One-year release discrepancy requires corroborating director, including name-order and accent variants', async () => {
      for (const director of ['Shō Miyake', 'Other Director']) {
        const f = await fixture(browser, { html: withMetadata(imdbFixture(), { name: 'Diary Without Words', datePublished: '2018-01-01', duration: 'PT1H', director: [{ name: director }] }),
          job: makeJob({ matchCheck: true, sourceMetadata: { titles: ['Diary Without Words 2018'], years: [2019], directors: ['Miyake Sho'], duration: 60 } }) });
        await f.waitState(director === 'Shō Miyake' ? 'done' : 'review');
        assert.equal(await f.read('fixture:submits'), director === 'Shō Miyake' ? 1 : null);
        await f.finish();
      }
    });

    await test('IMDb ignores a random hash, an unknown token, and a job for a different film', async () => {
      for (const setup of [
        { url: 'https://www.imdb.com/title/' + ID + '/#unrelated' },
        { url: 'https://www.imdb.com/title/' + ID + '/#dbimdb=' + TOKEN },
        { job: makeJob({ imdbId: 'tt9999999' }) },
        { job: makeJob({ state: 'done' }) },
        { job: makeJob({ createdAt: Date.now() - 700000 }) }
      ]) {
        const f = await fixture(browser, { html: imdbFixture(), ...setup });
        await f.page.waitForTimeout(100);
        assert.equal(await f.page.locator('#dbimdb-helper').count(), 0);
        assert.equal(await f.read('fixture:opens'), null);
        assert.equal(await f.read('fixture:watchedClicks'), null);
        await f.finish();
      }
    });

    await test('Existing identical IMDb score is recognized without reopening/submitting', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8 }), job: makeJob() });
      await f.waitState('done');
      assert.equal((await f.job()).outcome, 'done');
      assert.equal(await f.read('fixture:submits'), null);
      assert.equal(await f.read('fixture:opens'), null);
      await f.finish();
    });

    await test('Existing different IMDb score is preserved by default', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 7 }), job: makeJob() });
      await f.waitState('done');
      assert.equal((await f.job()).outcome, 'kept');
      assert.equal(await f.read('fixture:rating'), 7);
      assert.equal(await f.read('fixture:opens'), null);
      await f.finish();
    });

    await test('Mine collect alias resolves the canonical owner list and reads the current grid', async () => {
      const f = await fixture(browser, { url: 'https://movie.douban.com/mine?status=collect',
        html: '<body><div id="db-usr-profile"><a href="/people/test-user/collect">看过</a></div><div class="grid-view"><div class="item"><div class="info"><div class="title"><a href="/subject/64000/">Alias movie</a></div><span class="rating4-t"></span></div></div></div></body>' });
      await f.page.getByRole('button', { name: '读取本页', exact: true }).click();
      await f.page.waitForFunction(key => JSON.parse(localStorage.getItem('gm:' + key) || '{}').items?.length === 1, STORE);
      assert.equal((await f.read('gm:' + STORE)).source, '/people/test-user/collect');
      await f.finish();
    });

    await test('Missing Douban detail 404 keeps the failed item and continues other titles', async () => {
      const items = [64001, 64002].map(id => ({ id: String(id), title: '404 test ' + id, stars: 4, status: 'pending', note: '', imdbId: null }));
      const f = await fixture(browser, { url: 'https://movie.douban.com/people/test-user/collect', html: '<body>404 fixture</body>',
        seed: { [STORE]: { source: '/people/test-user/collect', items } }, pages: {
          '/subject/64001/': { status: 404, body: 'Not found' },
          '/subject/64002/': '<body><div id="info">IMDb: tt0111161</div></body>'
        }, workers: [{}] });
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['error', 'done']);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
      await f.finish();
    });

    await test('Worker reports an account outage to the controller without rapidly reloading on its own', async () => {
      const f = await fixture(browser, { html: imdbFixture({ failAccountLoads: 999 }),
        job: makeJob({ stars: null, autoRecovery: true }), fastRecovery: true });
      await f.waitState('error');
      const current = await f.job();
      assert.equal(current.recoverable, true);
      assert.equal(current.errorType, 'account-loading');
      assert.equal(await f.read('fixture:loads'), 1);
      assert.equal(await f.read('fixture:watchedClicks'), null);
      await f.finish();
    });

    await test('Uncertain verify worker preserves intent when account loading requires a controller cooldown', async () => {
      const f = await fixture(browser, { html: imdbFixture({ failAccountLoads: 999 }),
        job: makeJob({ stars: null, state: 'verify', desired: { kind: 'watched' }, autoRecovery: true }), fastRecovery: true });
      await f.waitState('error');
      const current = await f.job();
      assert.equal(current.recoverable, true);
      assert.deepEqual(current.desired, { kind: 'watched' });
      assert.equal(await f.read('fixture:loads'), 1);
      assert.equal(await f.read('fixture:watchedClicks'), null);
      await f.finish();
    });

    await test('Login prompt is a manual blocker and never triggers automatic recovery or writes', async () => {
      const html = imdbFixture({ failAccountLoads: 999 }).replace('<body>', '<body><header id="imdbHeader"><a href="/registration/signin">Sign in</a></header>');
      const f = await fixture(browser, { html, job: makeJob({ stars: null, autoRecovery: true }), fastRecovery: true });
      await f.waitState('error');
      assert.equal((await f.job()).errorType, 'needs-user');
      assert.equal((await f.job()).recoverable, false);
      assert.equal(await f.read('fixture:loads'), 1);
      assert.equal(await f.read('fixture:watchedClicks'), null);
      await f.finish();
    });

    await test('Enabled watched placeholder waits for main account loading and never toggles an already watched film', async () => {
      const f = await fixture(browser, { html: imdbFixture({ accountLoadingMs: 450, initialWatched: true }), job: makeJob({ stars: null }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:watchedClicks'), null);
      assert.equal(await f.read('fixture:prematureClicks'), null);
      assert.equal(await f.read('fixture:watchlistClicks'), null);
      assert.equal(await f.read('fixture:loads'), 1);
      await f.finish();
    });

    await test('Enabled unrated placeholder does not open a rating prompt while account query is loading', async () => {
      const f = await fixture(browser, { html: imdbFixture({ accountLoadingMs: 450, initialRating: 10 }), job: makeJob() });
      await f.waitState('done');
      assert.equal((await f.job()).outcome, 'kept');
      assert.equal(await f.read('fixture:opens'), null);
      assert.equal(await f.read('fixture:submits'), null);
      assert.equal(await f.read('fixture:prematurePrompts'), null);
      await f.finish();
    });

    await test('Account query that fails on the first document reloads once and recovers without premature clicking', async () => {
      const f = await fixture(browser, { html: imdbFixture({ failAccountLoads: 1, initialWatched: true }),
        job: makeJob({ stars: null }), fastRecovery: true });
      await f.waitState('done');
      assert.equal(await f.read('fixture:loads'), 2);
      assert.equal((await f.job()).loadRetries, 1);
      assert.equal(await f.read('fixture:watchedClicks'), null);
      await f.finish();
    });

    await test('Permanently stuck account query stops after two reloads without any write', async () => {
      const f = await fixture(browser, { html: imdbFixture({ failAccountLoads: 999 }), job: makeJob({ stars: null }), fastRecovery: true });
      await f.waitState('error');
      assert.equal(await f.read('fixture:loads'), 3);
      assert.equal((await f.job()).loadRetries, 2);
      assert.equal(await f.read('fixture:watchedClicks'), null);
      assert.equal(await f.read('fixture:submits'), null);
      assert.ok(!(await f.read('fixture:jobHistory')).some(v => v.state === 'done'));
      await f.finish();
    });

    await test('Saved watched response with unchanged UI is verified on reload and clicked only once', async () => {
      const f = await fixture(browser, { html: imdbFixture({ staleAfterSubmit: true }), job: makeJob({ stars: null }), fastRecovery: true });
      await f.waitState('done');
      assert.equal(await f.read('fixture:watchedClicks'), 1);
      assert.equal(await f.read('fixture:loads'), 2);
      const atSubmit = await f.read('fixture:jobAtSubmit');
      assert.equal(atSubmit.state, 'verify');
      assert.deepEqual(atSubmit.desired, { kind: 'watched' });
      await f.finish();
    });

    await test('Saved rating with a stuck dialog is verified on reload without a duplicate submission', async () => {
      const f = await fixture(browser, { html: imdbFixture({ staleAfterSubmit: true }), job: makeJob(), fastRecovery: true });
      await f.waitState('done');
      assert.equal(await f.read('fixture:submits'), 1);
      assert.equal(await f.read('fixture:loads'), 2);
      const atSubmit = await f.read('fixture:jobAtSubmit');
      assert.equal(atSubmit.state, 'verify');
      assert.deepEqual(atSubmit.desired, { kind: 'rating', score: 8 });
      await f.finish();
    });

    await test('Unpersisted watched operation ends in error after bounded read-only verification retries', async () => {
      const f = await fixture(browser, { html: imdbFixture({ persistWatched: false }), job: makeJob({ stars: null }), fastRecovery: true });
      await f.waitState('error');
      assert.equal(await f.read('fixture:watchedClicks'), 1);
      assert.equal(await f.read('fixture:loads'), 4);
      assert.equal((await f.job()).verifyRetries, 2);
      assert.ok(!(await f.read('fixture:jobHistory')).some(v => v.state === 'done'));
      await f.finish();
    });

    await test('Unpersisted rating ends in error after bounded read-only verification retries', async () => {
      const f = await fixture(browser, { html: imdbFixture({ persistRating: false }), job: makeJob(), fastRecovery: true });
      await f.waitState('error');
      assert.equal(await f.read('fixture:submits'), 1);
      assert.equal(await f.read('fixture:loads'), 4);
      assert.equal((await f.job()).verifyRetries, 2);
      assert.ok(!(await f.read('fixture:jobHistory')).some(v => v.state === 'done'));
      await f.finish();
    });

    await test('Disabled loading Rate placeholder waits for the saved same score and never opens a prompt', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8, loadingRatingMs: 1000 }), job: makeJob() });
      await f.waitState('done');
      assert.equal(await f.read('fixture:opens'), null);
      assert.equal(await f.read('fixture:submits'), null);
      assert.equal(await f.read('fixture:rating'), 8);
      await f.finish();
    });

    await test('Same saved score loaded on prompt open does not wait for the intentionally disabled submit button', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8, staleUnrated: true, hydrateOnOpen: true, disableUnchangedRating: true }), job: makeJob() });
      await f.waitState('done');
      assert.equal(await f.read('fixture:opens'), 1);
      assert.equal(await f.read('fixture:starClicks'), null);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Same-score prompt with Remove rating waits for the late saved score without clicking stars', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8, staleUnrated: true, hydrateAfterOpen: 500, disableUnchangedRating: true }), job: makeJob() });
      await f.waitState('done');
      assert.equal(await f.read('fixture:opens'), 1);
      assert.equal(await f.read('fixture:starClicks'), null);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Saved target score arriving during star selection is recognized even if submit stays disabled', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8, initialDialogRating: '?', staleUnrated: true, hydrateOnStar: true, disableUnchangedRating: true }), job: makeJob() });
      await f.waitState('done');
      assert.equal(await f.read('fixture:starClicks'), 1);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Compact real IMDb score markup YOUR RATING8/10 is read without requiring spaces', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 8, compactMarkup: true, omitRatingLabel: true }), job: makeJob() });
      await f.waitState('done');
      assert.equal(await f.read('fixture:opens'), null);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Loading different saved score is preserved before any prompt opens', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 7, loadingRatingMs: 800 }), job: makeJob() });
      await f.waitState('done');
      assert.equal((await f.job()).outcome, 'kept');
      assert.equal(await f.read('fixture:opens'), null);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Fresh dialog score protects a rating when the title page initially showed stale unrated status', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 7, staleUnrated: true }), job: makeJob() });
      await f.waitState('done');
      assert.equal((await f.job()).outcome, 'kept');
      assert.equal(await f.read('fixture:starClicks'), null);
      assert.equal(await f.read('fixture:submits'), null);
      await f.finish();
    });

    await test('Unrated Douban film marks only the exact IMDb title watched and verifies persistence on reload', async () => {
      const f = await fixture(browser, { html: imdbFixture(), job: makeJob({ stars: null }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:watchedClicks'), 1);
      assert.equal(await f.read('fixture:otherWatchedClicks'), null);
      assert.equal(await f.read('fixture:watchlistClicks'), null);
      assert.equal(await f.read('fixture:opens'), null);
      assert.equal(await f.read('fixture:loads'), 2);
      assert.match((await f.job()).note, /刷新确认/);
      await f.finish();
    });

    await test('Watched-only mode leaves a supplied star score untouched', async () => {
      const f = await fixture(browser, { html: imdbFixture(), job: makeJob({ mode: 'watched' }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:watchedClicks'), 1);
      assert.equal(await f.read('fixture:rating'), null);
      assert.equal(await f.read('fixture:opens'), null);
      await f.finish();
    });

    await test('Already watched title is never toggled back off', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialWatched: true }), job: makeJob({ mode: 'watched' }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:watchedClicks'), null);
      assert.equal(await f.read('fixture:watched'), true);
      await f.finish();
    });

    await test('All 1–5 Douban stars submit exactly 2–10 IMDb points and confirm after a real reload', async () => {
      for (const stars of [1, 2, 3, 4, 5]) {
        const f = await fixture(browser, { html: imdbFixture(), job: makeJob({ stars }) });
        await f.waitState('done');
        assert.equal(await f.read('fixture:submits'), 1);
        assert.equal(await f.read('fixture:submittedScore'), stars * 2);
        assert.equal(await f.read('fixture:rating'), stars * 2);
        assert.equal(await f.read('fixture:loads'), 2);
        const history = await f.read('fixture:jobHistory');
        assert.ok(history.some(x => x.state === 'verify' && x.desired.score === stars * 2));
        assert.equal(history.at(-1).state, 'done');
        await f.finish();
      }
    });

    await test('Explicit overwrite replaces an existing different score', async () => {
      const f = await fixture(browser, { html: imdbFixture({ initialRating: 7 }), job: makeJob({ overwrite: true }) });
      await f.waitState('done');
      assert.equal(await f.read('fixture:rating'), 8);
      assert.equal(await f.read('fixture:submits'), 1);
      await f.finish();
    });

    await test('Expired task lease between star selection and submission prevents writing', async () => {
      const f = await fixture(browser, { html: imdbFixture({ cancelOnStar: true }), job: makeJob() });
      await f.waitState('error');
      assert.equal(await f.read('fixture:starClicks'), 1);
      assert.equal(await f.read('fixture:submits'), null);
      assert.equal(await f.read('fixture:rating'), null);
      await f.finish();
    });

    await test('Optimistic rating that disappears after reload never becomes success', async () => {
      const f = await fixture(browser, { html: imdbFixture({ persistRating: false }), job: makeJob() });
      await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture:loads') || '0') >= 2);
      await f.page.waitForTimeout(600);
      assert.equal((await f.job()).state, 'verify');
      assert.equal(await f.read('fixture:submits'), 1);
      assert.equal(await f.read('fixture:rating'), null);
      assert.ok(!(await f.read('fixture:jobHistory')).some(x => x.state === 'done'));
      await f.finish();
    });
  } finally { await browser.close(); }
  const report = { testedAt: new Date().toISOString(), script: path.basename(scriptPath), sourceSha256: require('node:crypto').createHash('sha256').update(source).digest('hex'), browser: 'isolated headless Chrome with fully intercepted offline requests', passed: results.filter(x => x.result === 'PASS').length, failed: results.filter(x => x.result === 'FAIL').length, results };
  fs.writeFileSync(path.join(__dirname, process.env.SCRIPT_PATH ? 'browser-fixtures-baseline-results.json' : 'browser-fixtures-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
  process.exitCode = report.failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
