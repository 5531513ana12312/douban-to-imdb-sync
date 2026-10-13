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
const scriptPath = path.join(__dirname, '..', 'douban-to-imdb.user.js');
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
      ratingRoot.textContent = 'YOUR RATING ';
      const button = document.createElement('button');
      button.setAttribute('aria-label', value === null ? 'Rate Fixture title' : 'Your rating ' + value + ' out of 10');
      const span = document.createElement('span');
      span.textContent = value === null ? 'Rate' : value + ' / 10';
      if (value === null) span.dataset.testid = 'hero-rating-bar__user-rating__unrated';
      button.append(span); ratingRoot.append(button); button.onclick = openRating;
    }
    function openRating() {
      count('opens');
      const modal = document.createElement('div'); modal.dataset.testid = 'promptable__pc';
      modal.innerHTML = '<div class="ipc-rating-display__rating"></div><div class="ipc-starbar"></div><button class="ipc-rating-prompt__rate-button" disabled aria-disabled="true">Rate</button>';
      const display = modal.querySelector('.ipc-rating-display__rating');
      display.textContent = String(config.initialDialogRating ?? read('rating', null) ?? '?');
      const submit = modal.querySelector('.ipc-rating-prompt__rate-button');
      let selected = null;
      for (let n = 1; n <= 10; n++) {
        const b = document.createElement('button'); b.className = 'ipc-starbar__rating__button'; b.setAttribute('aria-label', 'Rate ' + n); b.textContent = String(n);
        b.onclick = () => {
          count('starClicks'); selected = n; write('selected', n);
          if (!config.ignoreSelection) display.textContent = String(n);
          submit.disabled = false; submit.setAttribute('aria-disabled', 'false');
          if (config.cancelOnStar) {
            const lease = JSON.parse(localStorage.getItem('gm:${LOCK}'));
            lease.until = Date.now() - 1; localStorage.setItem('gm:${LOCK}', JSON.stringify(lease));
          }
        };
        modal.querySelector('.ipc-starbar').append(b);
      }
      submit.onclick = () => {
        count('submits'); write('submittedScore', selected);
        if (config.persistRating !== false) write('rating', selected);
        renderRating(selected); modal.remove();
      };
      document.body.append(modal);
    }
    const target = document.getElementById('targetWatched');
    function renderWatched(value) {
      target.textContent = value ? 'Watched' : 'Mark as watched';
      target.setAttribute('aria-label', value ? 'Unmark Fixture title as watched' : 'Mark Fixture title as watched');
    }
    target.onclick = () => { count('watchedClicks'); write('watched', true); renderWatched(true); };
    document.getElementById('otherWatched').onclick = () => count('otherWatchedClicks');
    document.getElementById('watchlist').onclick = () => count('watchlistClicks');
    renderRating(read('loads', 0) === 1 && config.staleUnrated ? null : read('rating', null));
    renderWatched(read('watched', false));
    </script></body></html>`;
}

async function fixture(browser, { html, url = 'https://www.imdb.com/title/' + ID + '/#dbimdb=' + TOKEN, job, seed = {}, pages = {}, workers = null } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const errors = [];
  const requests = [];
  await context.route('**/*', async route => {
    const request = route.request(); requests.push(request.url());
    const u = new URL(request.url());
    if (request.resourceType() === 'document' || pages[u.pathname + u.search] || pages[u.pathname]) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pages[u.pathname + u.search] || pages[u.pathname] || html });
    } else await route.abort();
  });
  const storage = { ...seed };
  if (job) {
    storage[JOB] = job;
    storage[LOCK] = { owner: OWNER, until: Date.now() + 240000 };
  }
  await context.addInitScript(({ storage, source, workers }) => {
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
    const workerEvents = [];
    let workerIndex = 0, activeWorkers = 0, maxActiveWorkers = 0;
    const recordWorkerEvent = event => {
      workerEvents.push(event);
      localStorage.setItem('fixture:workerEvents', JSON.stringify(workerEvents));
      localStorage.setItem('fixture:maxActiveWorkers', JSON.stringify(maxActiveWorkers));
    };
    window.GM_openInTab = url => {
      if (!workers) throw new Error('Unexpected tab opening during this fixture: ' + url);
      const token = new URLSearchParams(new URL(url).hash.slice(1)).get('dbimdb');
      const key = 'dbimdb:v1:job:' + token;
      const index = workerIndex++, config = workers[index] || {};
      activeWorkers++; maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      recordWorkerEvent({ type: 'open', index, url, token });
      const tab = {
        closed: false,
        close() { if (!this.closed) { this.closed = true; activeWorkers--; recordWorkerEvent({ type: 'close', index }); } }
      };
      setTimeout(() => {
        if (config.result === 'closed') { tab.close(); return; }
        const current = window.GM_getValue(key);
        const state = config.result === 'error' ? 'error' : 'done';
        window.GM_setValue(key, { ...current, state, outcome: 'done', note: state === 'done' ? 'fixture persisted and verified' : 'fixture worker failure' });
        recordWorkerEvent({ type: 'result', index, state });
      }, config.delay ?? 100);
      return tab;
    };
    window.eval(source);
  }, { storage, source, workers });
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
      await f.page.getByText('已完成 1 部试同步，跳过 1 部缺少 IMDb 编号的影片', { exact: false }).waitFor({ timeout: 12000 });
      const queue = await f.read('gm:' + STORE);
      assert.deepEqual(queue.items.map(item => item.status), ['error', 'done', 'pending']);
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
      await f.page.getByText('本次没有写入 IMDb：1 部影片的豆瓣详情均未提供 IMDb 编号', { exact: false }).waitFor({ timeout: 8000 });
      assert.equal((await f.read('gm:' + STORE)).items[0].status, 'error');
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
      await f.page.getByRole('button', { name: '同步待处理', exact: true }).click();
      await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('fixture:workerEvents') || '[]').some(e => e.type === 'open'));
      await f.page.getByRole('button', { name: '暂停', exact: true }).click();
      await f.page.waitForFunction(key => { const q = JSON.parse(localStorage.getItem('gm:' + key)); return q.items[0].status === 'done' && !document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled; }, STORE);
      assert.deepEqual((await f.read('gm:' + STORE)).items.map(i => i.status), ['done', 'pending', 'pending']);
      assert.equal((await f.read('fixture:workerEvents')).filter(e => e.type === 'open').length, 1);
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
  fs.writeFileSync(path.join(__dirname, 'browser-fixtures-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
  process.exitCode = report.failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
