const $ = (id) => document.getElementById(id);
const HINTS = {
  tiktok: 'مثال: https://www.tiktok.com/@name/video/123...',
  facebook: 'رابط فيديو أو ريلز أو منشور على فيسبوك',
  youtube: 'مثال: https://www.youtube.com/watch?v=...',
};
let platform = 'tiktok', info = null, comments = [];

// ---------- helpers ----------
const rnd = (n) => { // unbiased crypto random int in [0,n)
  const max = Math.floor(2 ** 32 / n) * n; let x;
  do { x = crypto.getRandomValues(new Uint32Array(1))[0]; } while (x >= max);
  return x % n;
};
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Local mode: talk to server.js (keys in .env). Static mode (GitHub Pages): run the same logic in the browser (keys in ⚙️ settings).
let SERVER = false;
const serverReady = fetch('api/ping').then((r) => { SERVER = r.ok; }).catch(() => {}).then(() => { $('gear').hidden = SERVER; });
const call = async (path, params) => {
  const r = await fetch(`api/${path}?` + new URLSearchParams(params));
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'حصل خطأ');
  return d;
};
const apiInfo = async (platform, url) => { await serverReady; return SERVER ? call('info', { platform, url }) : Engine.info(platform, url); };
const apiComments = async (platform, id, cursor) => { await serverReady; return SERVER ? call('comments', { platform, id, cursor }) : Engine.comments(platform, id, cursor); };
// ---------- demo data ----------
const DEMO_NAMES = ['أحمد علي','محمد سمير','سارة محمود','منى حسن','يوسف إبراهيم','نور الدين','هدى خالد','كريم عادل','ياسمين فؤاد','عمر طارق','دينا مصطفى','حسام رمضان','ريم جمال','مصطفى سعيد','آية عبدالله','خالد وليد','فاطمة الزهراء','إسلام صلاح','هاجر نبيل','عبدالرحمن شريف'];
const DEMO_TEXT = ['أنا عايز أكسب! 🙏','ربنا يوفقك يا مستعملينجو','مشاركة في المسابقة ❤️','يارب أكون الفايز','فيديو جميل جدا 👏','متابع من زمان وبحبكم','نفسي أكسب المرة دي 🤞','الله ينور عليكم'];
const demoComments = () => Array.from({ length: 120 }, (_, i) => ({
  uid: 'd' + (i % 60), name: DEMO_NAMES[i % DEMO_NAMES.length] + (i >= 20 ? ' ' + (Math.floor(i / 20) + 1) : ''), text: DEMO_TEXT[rnd(DEMO_TEXT.length)], avatar: '',
}));

// ---------- state: survives refresh + works with browser Back ----------
const KEY = 'giveaway_state_v1', ORDER = ['search', 'video', 'setup', 'results'];
let step = 'search', lastWinners = null, showToken = 0;
function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ platform, url: $('url').value, info, comments, count: $('winners').value, winners: lastWinners, step })); } catch {}
}
function go(s) { // record a new step in browser history (replace if unchanged)
  step = s;
  if (history.state && history.state.step === s) history.replaceState({ step: s }, ''); else history.pushState({ step: s }, '');
  save();
}
function fillVideo() {
  $('vThumb').src = info.thumb || 'logo.png';
  $('vTitle').textContent = info.title;
  $('vAuthor').textContent = (info.author ? info.author + ' · ' : '') + (info.count ? info.count + ' تعليق' : '');
  $('loadBtn').disabled = false; $('loadBtn').textContent = comments.length ? 'إعادة تحميل التعليقات' : 'تحميل التعليقات';
}
function render(s) { // draw the UI for a step from current data (used on refresh / Back)
  showToken++; stopConfetti(); // cancels a running countdown/wheel
  if (s === 'results' && !(lastWinners && lastWinners.length)) s = 'setup';
  if (s === 'setup' && !comments.length) s = 'video';
  if (s === 'video' && !info) s = 'search';
  step = s; showError('');
  $('progress').hidden = true;
  $('videoCard').hidden = !(info && s !== 'search');
  $('setupCard').hidden = !(comments.length && (s === 'setup' || s === 'results'));
  if (info) fillVideo();
  if (comments.length) updateSetup();
  const ov = $('overlay'); ov.hidden = s !== 'results';
  if (s === 'results') {
    $('countStage').hidden = true; $('wheelStage').hidden = true; $('flash').classList.remove('on');
    renderResults(lastWinners);
  }
}
window.addEventListener('popstate', (e) => render((e.state && e.state.step) || 'search'));
['url', 'winners'].forEach((id) => $(id).addEventListener('input', save));

// ---------- tabs & search ----------
function applyPlatformUI(p) {
  platform = p;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.p === p));
  $('hint').textContent = HINTS[p];
}
function setPlatform(p) { applyPlatformUI(p); resetAll(); go('search'); }
function resetAll() {
  info = null; comments = []; lastWinners = null; showError('');
  $('videoCard').hidden = true; $('setupCard').hidden = true; $('progress').hidden = true;
}
$('tabs').onclick = (e) => { const b = e.target.closest('.tab'); if (b && b.dataset.p !== platform) setPlatform(b.dataset.p); };

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  if (!url) return showError('ضع رابط الفيديو أولاً');
  resetAll();
  $('searchBtn').disabled = true; $('searchBtn').textContent = '...';
  try {
    info = url === 'demo'
      ? { id: 'demo', demo: true, title: 'فيديو تجريبي من مستعملينجو', author: 'مستعملينجو', thumb: 'logo.png', count: 120 }
      : await apiInfo(platform, url);
    fillVideo();
    $('videoCard').hidden = false;
    go('video');
  } catch (err) { showError(err.message); }
  $('searchBtn').disabled = false; $('searchBtn').textContent = 'بحث';
};

// ---------- load comments ----------
$('loadBtn').onclick = async () => {
  $('loadBtn').disabled = true; $('setupCard').hidden = true; showError('');
  $('progress').hidden = false; $('progressText').textContent = 'جاري التحميل... 0';
  comments = []; lastWinners = null;
  try {
    if (info.demo) { await sleep(700); comments = demoComments(); }
    else {
      let cursor = '';
      do {
        const d = await apiComments(platform, info.id, cursor);
        comments.push(...d.comments);
        cursor = d.next || '';
        $('progressText').textContent = `جاري التحميل... ${comments.length}` + (info.count ? ` من ${info.count}` : '');
      } while (cursor);
    }
    $('progress').hidden = true; $('loadBtn').textContent = 'إعادة تحميل التعليقات'; $('loadBtn').disabled = false;
    if (platform === 'tiktok' && !info.demo) comments.forEach((c) => { c.link = `https://www.tiktok.com/@${info.owner}/video/${info.id}`; c.linkVideoOnly = true; });
    comments = comments.filter((c) => c.text && c.text.trim() && !(info.owner && String(c.uid) === String(info.owner)) && !/مستعملينجو/.test(c.name || ''));
    if (!comments.length) return showError('لا توجد تعليقات على هذا الفيديو');
    updateSetup(); $('setupCard').hidden = false; go('setup');
    $('setupCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    $('progress').hidden = true; $('loadBtn').disabled = false; showError(err.message);
    if (comments.length) { updateSetup(); $('setupCard').hidden = false; }
  }
};
const personOf = (c) => c.uid || c.name;
const eligible = () => comments; // every loaded comment takes part, no filtering
const uniqueCount = () => new Set(eligible().map(personOf)).size;
function updateSetup() {
  $('cCount').textContent = comments.length;
  $('cUnique').textContent = ` (من ${new Set(comments.map(personOf)).size} شخص)`;
  $('winners').max = uniqueCount();
}

// ---------- draw ----------
function pickWinners(n) { // one random comment per person
  const by = new Map();
  for (const c of shuffle(eligible())) if (!by.has(personOf(c))) by.set(personOf(c), c);
  return shuffle([...by.values()]).slice(0, n);
}
$('startBtn').onclick = () => startDraw();
async function startDraw() {
  const n = parseInt($('winners').value, 10);
  if (!n || n < 1) return showError('اكتب عدد الفائزين');
  showError('');
  const btn = $('startBtn'); btn.disabled = true;
  try {
    const max = uniqueCount();
    if (n > max) return showError(`عدد الفائزين أكبر من عدد المشاركين (${max})`);
    await runShow(pickWinners(n));
  } catch (err) { showError(err.message); }
  finally { btn.disabled = false; btn.textContent = 'ابدأ السحب'; }
}

async function runShow(winners) {
  const my = ++showToken, alive = () => my === showToken; // Back/refresh cancels via render()
  lastWinners = winners; go('results');
  const ov = $('overlay');
  ov.hidden = false; $('results').hidden = true; $('flash').classList.remove('on');
  $('wheelStage').hidden = true; $('countStage').hidden = false;
  $('wheelBox').classList.remove('zoom'); $('wheelBox').style.opacity = ''; // reset
  stopConfetti();
  // countdown 10 -> 0
  for (let i = 10; i >= 0; i--) {
    const el = $('num'); el.textContent = i; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    beep(i === 0 ? 880 : 440, i === 0 ? .35 : .08);
    await sleep(1000);
    if (!alive()) return;
  }
  $('countStage').hidden = true; $('wheelStage').hidden = false;
  // whole wheel moment = ~2s: spin 1.1s, hold 0.2s, zoom-in 0.7s
  await spinWheel(1100);
  if (!alive()) return;
  await sleep(200);
  if (!alive()) return;
  $('wheelBox').classList.add('zoom');
  await sleep(650);
  if (!alive()) return;
  $('flash').classList.add('on');
  await sleep(250);
  if (!alive()) return;
  $('wheelStage').hidden = true;
  renderResults(winners);
  $('flash').classList.remove('on');
  startConfetti();
}

// ---------- wheel ----------
const SEGMENTS = 16;
function drawWheel(rot) {
  const cv = $('wheel'), ctx = cv.getContext('2d'), S = cv.width, R = S / 2, N = SEGMENTS, a = (Math.PI * 2) / N;
  ctx.clearRect(0, 0, S, S);
  ctx.save(); ctx.translate(R, R);
  ctx.beginPath(); ctx.arc(0, 0, R - 4, 0, 7); ctx.fillStyle = '#ffd43b'; ctx.fill();
  for (let i = 0; i < N; i++) {
    const s = rot + i * a;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R - 26, s, s + a); ctx.closePath();
    ctx.fillStyle = i % 4 === 0 ? '#ffffff' : i % 4 === 1 ? '#2f7cf0' : i % 4 === 2 ? '#dcebff' : '#1556b8';
    ctx.fill(); ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 3; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, 70, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.lineWidth = 10; ctx.strokeStyle = '#ffd43b'; ctx.stroke();
  ctx.restore();
}
function spinWheel(dur) {
  const a = (Math.PI * 2) / SEGMENTS, final = Math.PI * 2 * 3 + Math.random() * Math.PI * 2;
  const t0 = performance.now(); let lastTick = -1;
  return new Promise((done) => {
    const frame = (now) => {
      const p = Math.min((now - t0) / dur, 1), rot = final * (1 - Math.pow(1 - p, 3));
      drawWheel(rot);
      const seg = Math.floor(rot / a); if (seg !== lastTick) { lastTick = seg; if (p < 1) beep(1200, .02); }
      p < 1 ? requestAnimationFrame(frame) : done();
    };
    requestAnimationFrame(frame);
  });
}

// ---------- results ----------
function renderResults(winners) {
  const list = $('winList'); list.innerHTML = '';
  winners.forEach((w, i) => {
    const d = document.createElement(w.link ? 'a' : 'div'); d.className = 'win';
    if (w.link) Object.assign(d, { href: w.link, target: '_blank', rel: 'noopener', title: 'افتح على المنصة' }); d.style.animationDelay = i * 0.25 + 's';
    const av = w.avatar ? Object.assign(document.createElement('img'), { src: w.avatar, className: 'av', referrerPolicy: 'no-referrer' }) : null;
    d.innerHTML = `<div class="rank">${i + 1}</div>`;
    if (av) { av.onerror = () => av.remove(); d.appendChild(av); }
    const b = document.createElement('div'); b.className = 'wbody';
    const n = document.createElement('div'); n.className = 'wname'; n.textContent = w.name;
    if (w.linkVideoOnly && w.uid) { const u = document.createElement('small'); u.className = 'wuser'; u.dir = 'ltr'; u.textContent = ' @' + w.uid; n.appendChild(u); } // TikTok: show @username to find the commenter
    const t = document.createElement('div'); t.className = 'wtext'; t.textContent = w.text;
    b.append(n, t);
    if (w.link) { const l = document.createElement('div'); l.className = 'wlink'; l.textContent = w.linkVideoOnly ? 'فتح الفيديو على تيك توك ↗' : `فتح التعليق على ${platform === 'youtube' ? 'يوتيوب' : 'فيسبوك'} ↗`; b.appendChild(l); }
    d.appendChild(b); list.appendChild(d);
  });
  $('results').hidden = false; $('results').scrollTop = 0;
}
$('close').onclick = () => history.back();
$('again').onclick = () => { stopConfetti(); startDraw(); };

// ---------- sound ----------
let actx;
function beep(freq, dur) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.value = 0.05; o.connect(g); g.connect(actx.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur); o.stop(actx.currentTime + dur);
  } catch {}
}

// ---------- confetti ----------
let cfRaf = 0;
function startConfetti() {
  const cv = $('confetti'), ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const cols = ['#16a34a', '#1d6fe8', '#ffd43b', '#ffffff', '#4ade80'];
  const ps = Array.from({ length: 140 }, () => ({ x: Math.random() * cv.width, y: -Math.random() * cv.height, w: 6 + Math.random() * 8, h: 10 + Math.random() * 10, vy: 2 + Math.random() * 4, vx: (Math.random() - .5) * 3, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: cols[rnd(cols.length)] }));
  const t0 = performance.now();
  const step = (now) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (now - t0 < 6000) cfRaf = requestAnimationFrame(step); else ctx.clearRect(0, 0, cv.width, cv.height);
  };
  cfRaf = requestAnimationFrame(step);
}
function stopConfetti() { cancelAnimationFrame(cfRaf); const cv = $('confetti'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); }

(function init() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEY)); } catch {}
  if (saved) {
    platform = saved.platform || 'tiktok'; info = saved.info || null; comments = saved.comments || []; lastWinners = saved.winners || null;
    $('url').value = saved.url || ''; if (saved.count) $('winners').value = saved.count;
  }
  applyPlatformUI(platform);
  const s = (history.state && history.state.step) || (saved && saved.step) || 'search';
  if (!history.state) { // fresh tab: rebuild the history chain so Back/Close have somewhere to go
    history.replaceState({ step: 'search' }, '');
    for (const x of ORDER.slice(1, ORDER.indexOf(s) + 1)) history.pushState({ step: x }, '');
  }
  render(s);
})();

// ---------- settings (keys for static hosting; stored only in this browser) ----------
const KEYS = ['youtube', 'apify'];
const readKeys = () => { try { return JSON.parse(localStorage.getItem('giveaway_keys') || '{}'); } catch { return {}; } };
$('gear').onclick = () => { const k = readKeys(); KEYS.forEach((n) => { $('key_' + n).value = k[n] || ''; }); $('settings').hidden = false; };
$('settingsClose').onclick = () => { $('settings').hidden = true; };
$('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').hidden = true; };
$('settingsSave').onclick = () => {
  const k = {}; KEYS.forEach((n) => { k[n] = $('key_' + n).value.trim(); });
  try { localStorage.setItem('giveaway_keys', JSON.stringify(k)); } catch {}
  $('settings').hidden = true; showError('');
};
