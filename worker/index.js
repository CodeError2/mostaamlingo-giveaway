// Cloudflare Worker: serves the static site (../docs) and the /api/* endpoints.
// API keys live in Worker secrets (YOUTUBE_API_KEY, APIFY_TOKEN) — never in the repo.
class UserError extends Error {}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function getJson(url, opt) {
  const res = await fetch(url, { ...opt, headers: { 'User-Agent': UA, ...(opt && opt.headers) } });
  try { return await res.json(); } catch { throw new UserError('رد غير متوقع من المنصة'); }
}

// ---------- YouTube ----------
const ytId = (url) => { const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/); return m && m[1]; };
async function ytInfo(url, env) {
  if (!env.YOUTUBE_API_KEY) throw new UserError('مفتاح YouTube غير مضبوط');
  const id = ytId(url);
  if (!id) throw new UserError('رابط يوتيوب غير صحيح');
  const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${id}&key=${env.YOUTUBE_API_KEY}`);
  if (d.error) throw new UserError('YouTube: ' + d.error.message);
  const v = d.items && d.items[0];
  if (!v) throw new UserError('الفيديو غير موجود أو خاص');
  const t = v.snippet.thumbnails;
  return { id, title: v.snippet.title, author: v.snippet.channelTitle, owner: v.snippet.channelId, thumb: (t.maxres || t.high || t.medium || t.default).url, count: Number(v.statistics.commentCount || 0) };
}
async function ytComments(id, cursor, env) {
  const d = await getJson(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=100&order=time&textFormat=plainText&key=${env.YOUTUBE_API_KEY}` + (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''));
  if (d.error) throw new UserError('YouTube: ' + d.error.message);
  return {
    comments: (d.items || []).map((i) => {
      const s = i.snippet.topLevelComment.snippet;
      return { uid: (s.authorChannelId && s.authorChannelId.value) || s.authorDisplayName, name: s.authorDisplayName, text: s.textDisplay, avatar: s.authorProfileImageUrl, link: `https://www.youtube.com/watch?v=${id}&lc=${i.id}` };
    }),
    next: d.nextPageToken || null,
  };
}

// ---------- TikTok (unofficial tikwm.com) ----------
async function tikwm(url) {
  for (let i = 0; i < 5; i++) {
    const d = await getJson(url);
    if (d.code === 0) return d.data;
    if (/limit/i.test(d.msg || '')) { await sleep(1200); continue; }
    throw new UserError('TikTok: ' + (d.msg || 'تعذر جلب البيانات'));
  }
  throw new UserError('TikTok: ضغط كبير، جرّب بعد لحظات');
}
async function ttInfo(url) {
  const d = await tikwm(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  return { id: String(d.id), title: d.title || 'فيديو تيك توك', author: d.author && (d.author.nickname || d.author.unique_id), owner: d.author && (d.author.unique_id || d.author.id), thumb: d.cover || d.origin_cover, count: d.comment_count || 0 };
}
async function ttComments(id, cursor) {
  const d = await tikwm(`https://www.tikwm.com/api/comment/list/?url=${id}&count=50&cursor=${cursor || 0}`);
  return {
    comments: (d.comments || []).map((c) => ({
      uid: (c.user && (c.user.unique_id || c.user.id)) || '',
      name: (c.user && (c.user.nickname || c.user.unique_id)) || 'مستخدم',
      text: c.text && c.text.trim() ? c.text : '(ملصق / صورة)',
      avatar: c.user && c.user.avatar,
    })),
    next: d.hasMore ? String(d.cursor) : null,
  };
}

const apifyMsg = (m) => /limit|usage|credit|billing/i.test(m || '')
  ? 'رصيد جلب فيسبوك المجاني خلص لهذا الشهر (بيتجدد يوم 15 كل شهر). تيك توك ويوتيوب شغالين عادي.'
  : 'Apify: ' + (m || 'تعذر بدء الجلب (تأكد من التوكن والرصيد)');
// ---------- Facebook (Apify, async run polled by the browser so it can show progress) ----------
const APIFY = 'https://api.apify.com/v2';
const apifyTokens = (env) => (env.APIFY_TOKENS || env.APIFY_TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean);
const isQuotaError = (m) => /limit|usage|credit|billing/i.test(m || '');
// ---------- Facebook Graph API (free, unlimited; works for videos/posts on the page the token belongs to) ----------
const GRAPH = 'https://graph.facebook.com/v19.0';
const BROWSER_UA = 'facebookexternalhit/1.1'; // full Chrome-style UAs get HTTP 400 here; this one gets the normal redirect
async function fbResolve(url) { // share links (/share/v/..., fb.watch) redirect to the real URL
  const orig = url;
  const short = (u) => /facebook\.com\/share\/|fb\.watch/.test(u);
  if (!short(url)) return url;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': BROWSER_UA } }); // without a UA (Workers send none) Facebook redirects to /unsupportedbrowser
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, url).href;
    if (/unsupportedbrowser|\/login|checkpoint/.test(next)) return orig; // bad redirect: keep the link as given
    url = next;
    if (!short(url)) break;
  }
  return url;
}
function fbObjectId(url, env) {
  let m = url.match(/(?:reel\/|videos\/|v=)(\d+)/);
  if (m) return m[1];
  m = url.match(/facebook\.com\/(\d+)\/posts\/(\d+)/);
  if (m) return `${m[1]}_${m[2]}`;
  m = url.match(/story_fbid=(\d+)/);
  const pid = (url.match(/[?&]id=(\d+)/) || [])[1] || env.FACEBOOK_PAGE_ID;
  if (m && pid) return `${pid}_${m[1]}`;
  m = url.match(/posts\/([A-Za-z0-9]+)/);
  if (m && env.FACEBOOK_PAGE_ID) return `${env.FACEBOOK_PAGE_ID}_${m[1]}`;
  return null;
}
async function fbGraphInfo(url, env) { // returns info, or null if Graph can't see this object (not on our page / bad token)
  const id = fbObjectId(await fbResolve(url), env), tok = encodeURIComponent(env.FACEBOOK_ACCESS_TOKEN);
  if (!id) return null;
  let d = await getJson(`${GRAPH}/${id}?fields=description,picture,from&access_token=${tok}`);
  if (d.error) d = await getJson(`${GRAPH}/${id}?fields=message,full_picture,from&access_token=${tok}`);
  if (d.error) { if (d.error.code === 190) throw new UserError('توكن فيسبوك انتهى. اعمل توكن جديد.'); return null; }
  const c = await getJson(`${GRAPH}/${id}/comments?summary=true&limit=0&filter=toplevel&access_token=${tok}`);
  return { id, title: (d.description || d.message || 'فيديو فيسبوك').slice(0, 140), author: d.from && d.from.name, owner: d.from && d.from.id, thumb: d.picture || d.full_picture || '', count: (c.summary && c.summary.total_count) || 0 };
}
async function fbGraphComments(id, cursor, env) {
  const d = await getJson(`${GRAPH}/${id}/comments?filter=toplevel&limit=100&fields=id,from,message,permalink_url&access_token=${encodeURIComponent(env.FACEBOOK_ACCESS_TOKEN)}` + (cursor ? `&after=${encodeURIComponent(cursor)}` : ''));
  if (d.error) throw new UserError(d.error.code === 190 ? 'توكن فيسبوك انتهى. اعمل توكن جديد.' : 'Facebook: ' + d.error.message);
  return {
    comments: (d.data || []).filter((c) => c.message).map((c) => ({ cid: c.id, uid: (c.from && c.from.id) || c.id, name: (c.from && c.from.name) || 'مستخدم فيسبوك', text: c.message, avatar: '', link: c.permalink_url || '' })),
    next: d.paging && d.paging.next ? d.paging.cursors.after : null,
  };
}

// ---------- Facebook via Bright Data (free tier ~5000 records/month; async snapshot polled by the browser) ----------
const BD = 'https://api.brightdata.com/datasets/v3', BD_DATASET = 'gd_lkay758p1eanlolqw8';
async function bdStart(url, env) { // returns snapshot id, or null when Bright Data can't take the job (no key / no credit / error)
  if (!env.BRIGHTDATA_API_KEY) return null;
  try {
    const res = await fetch(`${BD}/trigger?dataset_id=${BD_DATASET}&format=json&include_errors=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify([{ url }]),
    });
    const j = JSON.parse(await res.text());
    return j.snapshot_id || null;
  } catch { return null; }
}
async function bdPoll(snapshot, url, env) {
  const H = { headers: { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}` } };
  const pr = await getJson(`${BD}/progress/${snapshot}`, H);
  if (pr.status === 'failed') { // fall back to Apify
    const r = await startFbRun(url, apifyTokens(env), 0, Number(env.FB_MAX_COMMENTS) || 6000);
    if (r.run) return { comments: [], next: `${r.index}:${r.run.id}:${r.run.defaultDatasetId}`, progress: 0 };
    throw new UserError('فشل جلب التعليقات من فيسبوك، جرّب مرة أخرى');
  }
  if (pr.status !== 'ready') return { comments: [], next: 'bd:' + snapshot, progress: -1 }; // -1 = running, size unknown
  const rows = await getJson(`${BD}/snapshot/${snapshot}?format=json`, H);
  if (!Array.isArray(rows)) return { comments: [], next: 'bd:' + snapshot, progress: -1 }; // not downloadable yet
  return {
    comments: rows.filter((x) => x.comment_text && !x.reply && !x.parent_comment_id).map((x) => ({
      cid: x.comment_id, uid: x.user_id || x.user_url || x.user_name, name: x.user_name || 'مستخدم فيسبوك', text: x.comment_text, avatar: '', link: x.comment_link || '',
    })),
    next: null,
  };
}

async function fbInfo(url, env) {
  if (env.FACEBOOK_ACCESS_TOKEN) {
    const g = await fbGraphInfo(url, env);
    if (g) return g;
    if (!apifyTokens(env).length && !env.BRIGHTDATA_API_KEY) throw new UserError('الفيديو ده مش على صفحتك أو التوكن ناقصه صلاحيات');
  }
  if (!apifyTokens(env).length && !env.BRIGHTDATA_API_KEY) throw new UserError('فيسبوك غير مفعّل. ضع BRIGHTDATA_API_KEY أو APIFY_TOKENS أو FACEBOOK_ACCESS_TOKEN');
  if (!/facebook\.com|fb\.watch|fb\.com/.test(url)) throw new UserError('رابط فيسبوك غير صحيح');
  return { id: await fbResolve(url).catch(() => url), title: 'فيديو فيسبوك', author: '', owner: '', thumb: '', count: 0 }; // short share links must be expanded for the scrapers
}

const mapFb = (items) => items.filter((c) => c.text && !(c.threadingDepth > 0)).map((c) => ({
  cid: c.commentId || c.id || c.commentUrl || '', // lets the browser drop duplicates when a second run re-scrapes the same comments
  uid: c.profileId || c.profileUrl || c.profileName, name: c.profileName || 'مستخدم فيسبوك', text: c.text, avatar: c.profilePicture || '', link: c.commentUrl || '',
}));
// Start a run with the first token (from index `from`) that still has credit. Returns {index, run} or {error}.
async function startFbRun(url, tokens, from, max) {
  let lastMsg = '';
  for (let i = from; i < tokens.length; i++) {
    const run = await getJson(`${APIFY}/acts/apify~facebook-comments-scraper/runs?token=${encodeURIComponent(tokens[i])}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], resultsLimit: max, includeNestedComments: false, viewOption: 'RANKED_UNFILTERED' }),
    });
    if (run.data) return { index: i, run: run.data };
    lastMsg = run.error && run.error.message;
    if (!isQuotaError(lastMsg)) break; // real error (bad link/token): don't burn through the other accounts
  }
  return { error: lastMsg };
}
async function fbComments(url, cursor, env) {
  if (!/^https?:/.test(url)) return fbGraphComments(url, cursor, env); // numeric id => Graph API, URL => Bright Data / Apify
  if (cursor && cursor.startsWith('bd:')) return bdPoll(cursor.slice(3), url, env);
  const tokens = apifyTokens(env), max = Number(env.FB_MAX_COMMENTS) || 6000; // safety cap on how many comments (= credit) one video may use
  if (!cursor) { // first call: Bright Data first, else start an Apify run with the first token that still has credit
    const snap = await bdStart(url, env);
    if (snap) return { comments: [], next: 'bd:' + snap, progress: -1 };
    const r = await startFbRun(url, tokens, 0, max);
    if (r.error !== undefined) throw new UserError(apifyMsg(r.error));
    return { comments: [], next: `${r.index}:${r.run.id}:${r.run.defaultDatasetId}`, progress: 0 };
  }
  const [idx, runId, ds] = cursor.split(':');
  const token = encodeURIComponent(tokens[Number(idx)] || tokens[0]);
  const [st, d] = await Promise.all([getJson(`${APIFY}/actor-runs/${runId}?token=${token}`), getJson(`${APIFY}/datasets/${ds}?token=${token}`)]);
  const status = st.data && st.data.status;
  if (status === 'SUCCEEDED') {
    const items = await getJson(`${APIFY}/datasets/${ds}/items?token=${token}&clean=1`);
    if (!Array.isArray(items)) throw new UserError('Apify: تعذر قراءة النتائج');
    return { comments: mapFb(items), next: null };
  }
  if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    // The run died (typically this account ran out of credit mid-way). Keep what it already collected,
    // then continue on the next token. Apify can't resume, so the next run re-scrapes; the browser drops duplicates.
    const raw = await getJson(`${APIFY}/datasets/${ds}/items?token=${token}&clean=1`);
    const partial = Array.isArray(raw) ? mapFb(raw) : [];
    const quotaLike = partial.length > 0 || status === 'ABORTED' || isQuotaError(st.data && st.data.statusMessage);
    if (!quotaLike) throw new UserError('Apify: فشل الجلب (' + status + ')، تأكد من الرابط والرصيد');
    const r = await startFbRun(url, tokens, Number(idx) + 1, max);
    if (r.run) return { comments: partial, next: `${r.index}:${r.run.id}:${r.run.defaultDatasetId}`, progress: 0 };
    if (partial.length) return { comments: partial, next: null, warning: `الرصيد خلص في كل الحسابات، فاتجمع ${partial.length} تعليق بس من الفيديو.` };
    throw new UserError(apifyMsg(r.error));
  }
  return { comments: [], next: cursor, progress: (d.data && d.data.itemCount) || 0 };
}

const providers = { youtube: { info: ytInfo, comments: ytComments }, tiktok: { info: ttInfo, comments: ttComments }, facebook: { info: fbInfo, comments: fbComments } };

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (u.pathname === '/api/ping') return json({ ok: true });
      const p = providers[u.searchParams.get('platform')];
      if (!p) throw new UserError('منصة غير مدعومة');
      if (u.pathname === '/api/info') return json(await p.info(u.searchParams.get('url') || '', env));
      if (u.pathname === '/api/comments') return json(await p.comments(u.searchParams.get('id'), u.searchParams.get('cursor'), env));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof UserError ? e.message : 'حصل خطأ غير متوقع' }, e instanceof UserError ? 400 : 500);
    }
  },
};
