/* Isolated multi-tab benchmark. All URLs are fulfilled locally, no account is used.
 * GM APIs are simulated with a Node-backed shared store. No browser profile is read.
 * Headless timing is not a measurement of IMDb's network or service limits.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sourcePath = path.join(__dirname, '..', 'douban-to-imdb.user.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const STORE = 'dbimdb:v1:queue', JOB = 'dbimdb:v1:job:';
const reports = [];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function movieHtml(id, index, config) {
  // A deterministic mixed workload: fresh ratings, watched, existing same/different ratings.
  const kind = index % 10;
  const target = ((index % 5) + 1) * 2;
  const initial = kind === 0 ? target : kind === 1 ? (target === 10 ? 8 : 10) : null;
  return `<!doctype html><body><h1>Bench Movie ${index}</h1>
    <div data-testid="hero-rating-bar__aggregate-rating">IMDb RATING 9.0 / 10</div>
    <div data-testid="hero-rating-bar__user-rating" id="rating"></div>
    <button data-testid="watched-button-${id}" id="watched"></button>
    <button data-testid="tm-box-wl-button" id="primary">Add to Watchlist</button>
    <script>
    const id = ${JSON.stringify(id)}, score = ${target}, kind = ${kind};
    const key = 'film:' + id;
    const previous = JSON.parse(localStorage.getItem(key) || 'null');
    const state = previous || {rating:${initial},watched:false};
    const root = document.getElementById('rating'), watched = document.getElementById('watched');
    function blockAccount() {
      const primary = document.getElementById('primary');
      primary.setAttribute('aria-label','Loading');
      primary.innerHTML='<div data-testid="tm-box-wl-loader">Loading</div>';
    }
    const blockedBefore = ${!!config.blockedBefore}, blockedAfter = ${!!config.blockedAfter};
    if (blockedBefore || (blockedAfter && ${!!config.alreadyAttempted})) blockAccount();
    function render() {
      root.textContent = 'YOUR RATING ';
      const b = document.createElement('button');
      const span = document.createElement('span');
      span.dataset.testid = state.rating === null ? 'hero-rating-bar__user-rating__unrated' : 'hero-rating-bar__user-rating__score';
      span.textContent = state.rating === null ? 'Rate' : state.rating + '/10';
      b.setAttribute('aria-label', state.rating === null ? 'Rate Bench Movie' : 'Your rating ' + state.rating + ' out of 10');
      b.append(span); root.append(b); b.onclick = dialog;
      watched.textContent = state.watched ? 'Watched' : 'Mark as watched';
      watched.setAttribute('aria-label', state.watched ? 'Unmark Bench Movie as watched' : 'Mark Bench Movie as watched');
    }
    function dialog() {
      const modal = document.createElement('div'); modal.dataset.testid = 'promptable__pc';
      modal.innerHTML = '<div class="ipc-rating-display__rating">?</div><div class="ipc-starbar"></div><button class="ipc-rating-prompt__rate-button" disabled>Rate</button>';
      const submit = modal.querySelector('.ipc-rating-prompt__rate-button');
      let selected;
      for (let n=1;n<=10;n++) {
        const b=document.createElement('button');b.className='ipc-starbar__rating__button';b.setAttribute('aria-label','Rate '+n);b.textContent=n;
        b.onclick=()=>{selected=n;modal.querySelector('.ipc-rating-display__rating').textContent=n;submit.disabled=false;};
        modal.querySelector('.ipc-starbar').append(b);
      }
      submit.onclick=async()=>{
        await window.benchBridge('submission',{id,kind:'rating',score:selected});
        setTimeout(()=>{state.rating=selected;localStorage.setItem(key,JSON.stringify(state));render();modal.remove();},${config.saveMs ?? 200});
      };
      document.body.append(modal);
    }
    watched.onclick=async()=>{
      await window.benchBridge('submission',{id,kind:'watched'});
      setTimeout(()=>{state.watched=true;localStorage.setItem(key,JSON.stringify(state));if(blockedAfter)blockAccount();else render();},${config.saveMs ?? 200});
    };
    root.innerHTML='<button disabled aria-label="Loading rating">Rate</button>';
    setTimeout(render, ${config.hydrationMs ?? 250} + (${index} % 3)*100);
    </script></body>`;
}

async function scenario(browser, { parallel, count = Number(process.env.BENCH_COUNT || 32), trial = 1, config = {}, label = 'paced-mixed', script = source }) {
  if(config.fastRecovery) script = script.replace('const ACCOUNT_WAIT = 15000;', 'const ACCOUNT_WAIT = 1000;')
    .replace('const VERIFY_WAIT = 20000;', 'const VERIFY_WAIT = 1000;')
    .replace('const ACK_WAIT = 4000;', 'const ACK_WAIT = 350;')
    .replace('const RELOAD_DELAY = 1500;', 'const RELOAD_DELAY = 10;')
    .replace('const RECOVERY_WAIT = 30000;', 'const RECOVERY_WAIT = 100;');
  if (process.env.BENCH_TAB_GAP !== undefined) {
    const gap = Number(process.env.BENCH_TAB_GAP);
    assert.ok(Number.isInteger(gap) && gap >= 0 && gap <= 5000, 'invalid lab launch gap');
    script = script.replace('const TAB_GAP = 350;', 'const TAB_GAP = ' + gap + ';');
  }
  // 24/32 are laboratory-only options; the distributed script stops at 16.
  if (parallel > 16) script = script.replace('const MAX_PARALLEL = 16;', 'const MAX_PARALLEL = 32;')
    .replace("['16', '实验：最多 16 部并行']", "['16', '实验：最多 16 部并行'], ['24', 'lab 24'], ['32', 'lab 32']");
  const items = Array.from({ length: count }, (_, i) => ({ id: String(70000+i), title: 'Bench Movie '+i,
    stars: i % 10 === 2 ? null : (i % 5)+1, status:'pending', note:'',
    imdbId: config.coldDetails ? null : config.duplicates && i % 5 === 1 ? 'tt'+String(5000000+i-1) : 'tt'+String(5000000+i) }));
  const historyItems = Array.from({ length: 1201-count }, (_, i) => ({id:String(80000+i), title:'Previously done '+i, stars:4, imdbId:'tt'+String(6000000+i),status:'done',note:'previously verified'}));
  const store = new Map([[STORE,{source:'/people/benchmark/collect',items:[...items,...historyItems]}],['dbimdb:v3:parallel',parallel]]);
  const context = await browser.newContext({serviceWorkers:'block'});
  const events=[], failures=[], submissions=[], taskMs=[], handles=new Map(), pageSet=new Set();
  const blockedTokens = new Set();
  let controller, active=0, peak=0, bridgeBytes=0, queueWrites=0, started, pausedAt=null;
  let lastOpenAt=0, minOpenGap=Infinity, failureSeenAt=null;
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if (u.hostname === 'movie.douban.com') {
      const subject = u.pathname.match(/^\/subject\/(\d+)\//)?.[1];
      if(subject) {
        await new Promise(r=>setTimeout(r,250));
        await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body><div id="info">IMDb: tt'+String(5000000+Number(subject)-70000)+'</div></body>'});
      } else await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body>Offline benchmark controller</body>'});
      return;
    }
    if (route.request().resourceType() !== 'document') { await route.abort(); return; }
    const id=u.pathname.match(/tt\d+/)?.[0];
    if (!id) { await route.abort(); return; }
    const index=Number(id.slice(2))-5000000;
    await new Promise(resolve=>setTimeout(resolve,(config.loadMs ?? 900)+(index%4)*100));
    const token = new URLSearchParams(u.hash.slice(1)).get('dbimdb');
    // HTTP drops fragments; the harness associates this isolated page with its job.
    const pageToken = token || [...handles.values()].find(h=>h.page===route.request().frame().page())?.token;
    const blocked = blockedTokens.has(pageToken);
    await route.fulfill({status:200,contentType:'text/html',body:movieHtml(id,index,{...config,
      blockedBefore: blocked && config.failBeforeReadOnce,
      blockedAfter: blocked && config.failAfterSubmitOnce,
      alreadyAttempted: !!store.get(JOB+pageToken)?.desired})});
  });
  async function broadcast(key,value,origin) {
    if (!key.startsWith(JOB) && key !== 'dbimdb:v1:lock') return;
    await Promise.all([...pageSet].filter(p=>p!==origin&&!p.isClosed()).map(p=>p.evaluate(({key,value})=>{
      if (window.benchStore) { if(value===undefined) delete window.benchStore[key];else window.benchStore[key]=value; }
    },{key,value:clone(value)}).catch(()=>{})));
  }
  async function openWorker(url, origin, clientOpenedAt) {
    const token=new URLSearchParams(new URL(url).hash.slice(1)).get('dbimdb');
    const id=new URL(url).pathname.match(/tt\d+/)[0];
    const ordinal=events.filter(e=>e.type==='open').length;
    const openedAt=clientOpenedAt || Date.now();
    if(lastOpenAt) minOpenGap=Math.min(minOpenGap,openedAt-lastOpenAt);
    lastOpenAt=openedAt;
    const h={token,id,page:null,closed:false,openedAt};handles.set(token,h);
    const initialJob = store.get(JOB+token);
    const priorOpen = events.some(e=>e.type==='open'&&e.id===id);
    if(!priorOpen&&id==='tt5000002'&&(config.failBeforeReadOnce||config.failAfterSubmitOnce))blockedTokens.add(token);
    active++;peak=Math.max(peak,active);events.push({type:'open',token,id,at:openedAt,active,state:initialJob?.state,desired:clone(initialJob?.desired)});
    assert.ok(![...handles.values()].some(other=>other!==h&&!other.closed&&other.id===id),'same title opened concurrently');
    if(config.failFirst&&ordinal===0){
      setTimeout(async()=>{const v={...store.get(JOB+token),state:'error',note:'injected worker failure'};store.set(JOB+token,v);failureSeenAt=Date.now();events.push({type:'injectedError',at:failureSeenAt});await broadcast(JOB+token,v);},config.failureMs??100);
      return;
    }
    const page=await context.newPage();h.page=page;pageSet.add(page);
    page.on('pageerror',e=>failures.push(e.message));
    page.on('close',()=>{pageSet.delete(page);if(!h.closed){h.closed=true;active--;events.push({type:'closedUnexpectedly',token,at:Date.now()});origin.evaluate(token=>window.benchHandles.get(token).closed=true,token).catch(()=>{});}});
    await page.goto(url,{waitUntil:'domcontentloaded'});
  }
  await context.exposeBinding('benchBridge',async({page},action,data)=>{
    if(action==='snapshot')return Object.fromEntries([...store.entries()].map(([k,v])=>[k,clone(v)]));
    if(action==='set') {
      const v=clone(data.value);store.set(data.key,v);bridgeBytes+=JSON.stringify(v).length;
      if(data.key===STORE)queueWrites++;
      if(data.key.startsWith(JOB)&&v.state==='done') {const h=handles.get(v.token);if(h)taskMs.push(Date.now()-h.openedAt);}
      if(data.key.startsWith(JOB)&&v.state==='error') console.error('WORKER ERROR '+v.note);
      await broadcast(data.key,v,page);return;
    }
    if(action==='delete'){store.delete(data.key);await broadcast(data.key,undefined,page);return;}
    if(action==='open'){openWorker(data.url,page,data.clientOpenedAt).catch(e=>failures.push(e.stack));return;}
    if(action==='close'){
      const h=handles.get(data.token);if(h&&!h.closed){h.closed=true;active--;events.push({type:'close',token:data.token,at:Date.now()});if(h.page&&!h.page.isClosed())await h.page.close();}return;
    }
    if(action==='submission'){submissions.push({...data,at:Date.now()});return;}
  });
  await context.addInitScript(async source=>{
    window.benchStore=await window.benchBridge('snapshot');
    window.benchHandles=new Map();
    window.GM_getValue=(k,f=null)=>k in window.benchStore?JSON.parse(JSON.stringify(window.benchStore[k])):f;
    window.GM_setValue=(k,v)=>{window.benchStore[k]=JSON.parse(JSON.stringify(v));void window.benchBridge('set',{key:k,value:v});};
    window.GM_deleteValue=k=>{delete window.benchStore[k];void window.benchBridge('delete',{key:k});};
    window.GM_registerMenuCommand=()=>{};
    window.GM_openInTab=(url,options)=>{
      const token=new URLSearchParams(new URL(url).hash.slice(1)).get('dbimdb');
      const h={closed:false,close(){if(!this.closed){this.closed=true;void window.benchBridge('close',{token});}}};
      window.benchHandles.set(token,h);void window.benchBridge('open',{url,options,clientOpenedAt:Date.now()});return h;
    };
    window.GM_xmlhttpRequest=()=>{throw new Error('Unexpected external search');};
    if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
    window.eval(source);
  },script);
  try {
    controller=await context.newPage();pageSet.add(controller);controller.on('pageerror',e=>failures.push(e.message));
    await controller.goto('https://movie.douban.com/people/benchmark/collect');
    await controller.getByLabel('同步速度',{exact:true}).selectOption(String(parallel));
    started=Date.now();await controller.getByRole('button',{name:'同步待处理',exact:true}).click();
    if(config.pause){
      while(events.filter(e=>e.type==='open').length<Math.min(parallel,count))await new Promise(r=>setTimeout(r,50));
      await controller.getByRole('button',{name:'暂停',exact:true}).click();pausedAt=Date.now();
    }
    await controller.waitForFunction(()=>!document.querySelector('#dbimdb-helper').shadowRoot.querySelector('.actions button').disabled,null,{timeout:180000});
    const end=Date.now();
    await new Promise(r=>setTimeout(r,100));
    const queue=store.get(STORE), current=queue.items.slice(0,count);
    const confirmed=current.filter(i=>['done','kept'].includes(i.status));
    assert.deepEqual(failures,[],'browser errors');assert.ok(peak<=parallel,'concurrency exceeded');
    if(config.pause){assert.equal(events.filter(e=>e.type==='open'&&e.at>pausedAt).length,0,'new page after pause');assert.ok(current.some(i=>i.status==='pending'));}
    else if(config.failFirst){assert.equal(current.filter(i=>i.status==='error').length,1);assert.equal(events.filter(e=>e.type==='open').length,1);assert.equal(submissions.length,0);}
    else {
      assert.equal(confirmed.length,count,'all titles must be confirmed');
      for(const i of current){const task=store.get(JOB+i.token);assert.equal(task.state,'done');if(task.desired)assert.match(task.note,/刷新确认/,'new writes must be verified after reload');}
      assert.equal(new Set(submissions.map(s=>s.id)).size,submissions.length,'duplicate writes');
      assert.equal(queue.items.slice(count).filter(i=>i.status==='done').length,1201-count,'history preserved');
      if(config.failBeforeReadOnce||config.failAfterSubmitOnce) {
        const targetOpens=events.filter(e=>e.type==='open'&&e.id==='tt5000002');
        assert.equal(targetOpens.length,2,'failed title must be reopened exactly once');
        assert.equal(submissions.filter(s=>s.id==='tt5000002').length,1,'watched title submitted exactly once');
        assert.ok(events.filter(e=>e.type==='open'&&e.at>=targetOpens[1].at).every(e=>e.active===1),'recovery runs one worker at a time');
        if(config.failAfterSubmitOnce) {
          assert.equal(targetOpens[1].state,'verify','uncertain write resumes read-only');
          assert.equal(targetOpens[1].desired.kind,'watched');
        }
        const firstFailure=store.get(JOB+targetOpens[0].token);
        assert.equal(firstFailure.recoverable,true);
        assert.equal(firstFailure.errorType,'account-loading');
        assert.ok(events.some(e=>e.type==='close'&&e.token===targetOpens[0].token),'transient failed page closed');
      }
    }
    const row={label,parallel,trial,count,configuredTabGapMs:Number(script.match(/const TAB_GAP = (\d+);/)?.[1] ?? 350),
      sourceVariantSha256:crypto.createHash('sha256').update(script).digest('hex'),confirmed:confirmed.length,errors:current.filter(i=>i.status==='error').length,
      elapsedSeconds:+((end-started)/1000).toFixed(3),confirmedPerMinute:+(confirmed.length*60000/(end-started)).toFixed(2),
      peakActiveTabs:peak,newWrites:submissions.length,newWritesPerMinute:+(submissions.length*60000/(end-started)).toFixed(2),queueWrites,sharedWriteMiB:+(bridgeBytes/1048576).toFixed(2),
      minLaunchGapMs:Number.isFinite(minOpenGap)?minOpenGap:null,medianWorkerMs:taskMs.length?taskMs.sort((a,b)=>a-b)[Math.floor(taskMs.length/2)]:null,
      openedPages:events.filter(e=>e.type==='open').length,failedPages:blockedTokens.size,
      result:'PASS',note:config.pause?'pause stops new pages and drains existing work':config.failFirst?'failure cancels queued tab openings':'mixed operations with refreshed persistence verification'};
    reports.push(row);console.log(JSON.stringify(row));return row;
  } finally {await context.close();}
}

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const testedAt=new Date().toISOString();
  try {
    if(process.env.BENCH_RECOVERY_ONLY) {
      await scenario(browser,{parallel:6,count:12,config:{failBeforeReadOnce:true,fastRecovery:true},label:'adaptive-before-write'});
      await scenario(browser,{parallel:6,count:12,config:{failAfterSubmitOnce:true,fastRecovery:true},label:'adaptive-after-write'});
    } else {
    const levels=(process.env.BENCH_LEVELS||'2,4,6,8,10,16,24,32').split(',').map(Number);
    const trials=Number(process.env.BENCH_TRIALS||2);
    const profile = process.env.BENCH_PROFILE || (process.env.BENCH_TAB_GAP === '0' ? 'unpaced-local-only' : 'paced-mixed');
    for(let trial=1;trial<=trials;trial++)for(const parallel of trial%2?levels:[...levels].reverse())await scenario(browser,{parallel,trial,label:profile,config:profile==='cold-details'?{coldDetails:true}: {}});
    if(!process.env.BENCH_QUICK) {
    await scenario(browser,{parallel:10,count:20,config:{pause:true,loadMs:5000},label:'pause-10'});
    await scenario(browser,{parallel:16,count:24,config:{failFirst:true},label:'failure-16'});
    await scenario(browser,{parallel:10,count:20,config:{duplicates:true},label:'duplicate-10'});
    // Force long-lived tasks to actually occupy all 32 slots. Laboratory-only run.
    await scenario(browser,{parallel:32,count:40,config:{loadMs:12000},label:'slow-pages-32'});
    }
    }
  } finally {
    await browser.close();
    const report={testedAt,browserVersion:browser.version(),sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),
      environment:'isolated headless Chrome; all URLs fulfilled locally; Node shared GM store; 1201 queue entries',
      limits:'lightweight synthetic pages and fixed local delays; Playwright default background timer throttling disabled; no real Tampermonkey storage, full IMDb payload, service throttling, or real-account speed measurement',reports};
    const reportName = process.env.BENCH_RECOVERY_ONLY ? 'concurrency-adaptive-results.json' : process.env.BENCH_PROFILE === 'cold-details' ? 'concurrency-cold-results.json' : process.env.BENCH_TAB_GAP !== undefined ? 'concurrency-gap-results.json' : 'concurrency-benchmark-results.json';
    fs.writeFileSync(path.join(__dirname,reportName),JSON.stringify(report,null,2)+'\n');
    console.log('REPORT '+JSON.stringify({runs:reports.length,confirmed:reports.reduce((n,r)=>n+r.confirmed,0)}));
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
