// Giveaway site backend — zero dependencies (Node 18+).
// Fetches video info + comments from YouTube / TikTok / Facebook.
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- tiny .env loader ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = process.env.PORT || 3000;
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const FB_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const FB_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

class UserError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  let data;
  try { data = await res.json(); } catch { throw new UserError('رد غير متوقع من المنصة'); }
  return data;
}

// ================= YouTube =================
function ytId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m && m[1];
}
function needYt() {
  if (!YT_KEY) throw new UserError('مفتاح YouTube غير مضبوط. ضع YOUTUBE_API_KEY في ملف .env');
}
async function ytInfo(url) {
  needYt();
  const id = ytId(url);
  if (!id) throw new UserError('رابط يوتيوب غير صحيح');
  const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${id}&key=${YT_KEY}`);
  if (d.error) throw new UserError('YouTube: ' + d.error.message);
  const v = d.items && d.items[0];
  if (!v) throw new UserError('الفيديو غير موجود أو خاص');
  const t = v.snippet.thumbnails;
  return {
    id,
    title: v.snippet.title,
    author: v.snippet.channelTitle,
    owner: v.snippet.channelId,
    thumb: (t.maxres || t.high || t.medium || t.default).url,
    count: Number(v.statistics.commentCount || 0),
  };
}
async function ytComments(id, cursor) {
  needYt();
  const d = await getJson(
    `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=100&order=time&textFormat=plainText&key=${YT_KEY}` +
      (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : '')
  );
  if (d.error) throw new UserError('YouTube: ' + d.error.message);
  return {
    comments: (d.items || []).map((i) => {
      const s = i.snippet.topLevelComment.snippet;
      return {
        uid: (s.authorChannelId && s.authorChannelId.value) || s.authorDisplayName,
        name: s.authorDisplayName,
        text: s.textDisplay,
        avatar: s.authorProfileImageUrl,
        link: `https://www.youtube.com/watch?v=${id}&lc=${i.id}`,
      };
    }),
    next: d.nextPageToken || null,
  };
}

// ================= TikTok (unofficial: tikwm.com) =================
async function tikwm(endpoint) {
  for (let i = 0; i < 5; i++) {
    const d = await getJson(endpoint);
    if (d.code === 0) return d.data;
    if (/limit/i.test(d.msg || '')) { await sleep(1200); continue; }
    throw new UserError('TikTok: ' + (d.msg || 'تعذر جلب البيانات'));
  }
  throw new UserError('TikTok: ضغط كبير، جرّب بعد لحظات');
}
async function ttInfo(url) {
  const d = await tikwm(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  return {
    id: String(d.id),
    title: d.title || 'فيديو تيك توك',
    author: d.author && (d.author.nickname || d.author.unique_id),
    owner: d.author && (d.author.unique_id || d.author.id),
    thumb: d.cover || d.origin_cover,
    count: d.comment_count || 0,
  };
}
const ttMap = (c) => ({
  uid: (c.user && (c.user.unique_id || c.user.id)) || '',
  name: (c.user && (c.user.nickname || c.user.unique_id)) || 'مستخدم',
  text: c.text && c.text.trim() ? c.text : '(ملصق / صورة)',
  avatar: c.user && c.user.avatar,
});
async function ttComments(id, cursor) {
  const d = await tikwm(`https://www.tikwm.com/api/comment/list/?url=${id}&count=50&cursor=${cursor || 0}`);
  return { comments: (d.comments || []).map(ttMap), next: d.hasMore ? String(d.cursor) : null };
}

// ================= Facebook (Graph API) =================
function needFb() {
  if (!FB_TOKEN) throw new UserError('فيسبوك غير مفعّل بعد. ضع APIFY_TOKEN في ملف .env');
}
function fbObjectId(url) {
  let m = url.match(/(?:reel\/|videos\/|v=)(\d+)/);
  if (m) return m[1];
  m = url.match(/story_fbid=(\d+).*?[?&]id=(\d+)/) || url.match(/[?&]id=(\d+).*?story_fbid=(\d+)/);
  if (m) return /story_fbid=(\d+).*?id=/.test(m[0]) ? `${m[2]}_${m[1]}` : `${m[1]}_${m[2]}`;
  m = url.match(/facebook\.com\/(\d+)\/posts\/(\d+)/);
  if (m) return `${m[1]}_${m[2]}`;
  m = url.match(/posts\/([A-Za-z0-9]+)/);
  if (m && FB_PAGE_ID) return `${FB_PAGE_ID}_${m[1]}`;
  return null;
}
async function fbResolve(url) { // share links (/share/v/..., fb.watch) redirect to the real video URL
  if (!/facebook\.com\/share\/|fb\.watch/.test(url)) return url;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location');
    if (!loc) break;
    url = new URL(loc, url).href;
    if (!/facebook\.com\/share\/|fb\.watch/.test(url)) break;
  }
  return url;
}
// Easy path: Apify's Facebook comments scraper (works on any public video/post, no Meta app needed)
async function fbApifyInfo(url) {
  const real = await fbResolve(url);
  if (!/facebook\.com|fb\.watch/.test(real)) throw new UserError('رابط فيسبوك غير صحيح');
  return { id: real, title: 'فيديو فيسبوك', author: '', owner: '', thumb: '', count: 0 };
}
async function fbApifyComments(url) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~facebook-comments-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=280`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startUrls: [{ url }], resultsLimit: 6000, includeNestedComments: false, viewOption: 'RANKED_UNFILTERED' }) }
  );
  const d = await res.json().catch(() => null);
  if (!Array.isArray(d)) throw new UserError('Apify: ' + ((d && d.error && d.error.message) || 'تعذر جلب التعليقات (تأكد من التوكن والرصيد)'));
  return {
    comments: d
      .filter((c) => c.text && !(c.threadingDepth > 0))
      .map((c) => ({
        uid: c.profileId || c.profileUrl || c.profileName,
        name: c.profileName || 'مستخدم فيسبوك',
        text: c.text,
        avatar: c.profilePicture || '',
        link: c.commentUrl || '',
      })),
    next: null,
  };
}

async function fbInfo(url) {
  if (APIFY_TOKEN) return fbApifyInfo(url);
  needFb();
  const id = fbObjectId(await fbResolve(url));
  if (!id) throw new UserError('تعذر قراءة رابط فيسبوك. استخدم رابط فيديو/ريلز، أو اضبط FACEBOOK_PAGE_ID للمنشورات');
  let d = await getJson(`https://graph.facebook.com/v19.0/${id}?fields=description,picture,from&access_token=${FB_TOKEN}`);
  if (d.error) d = await getJson(`https://graph.facebook.com/v19.0/${id}?fields=message,full_picture,from&access_token=${FB_TOKEN}`);
  if (d.error) throw new UserError('Facebook: ' + d.error.message);
  const c = await getJson(`https://graph.facebook.com/v19.0/${id}/comments?summary=true&limit=1&access_token=${FB_TOKEN}`);
  return {
    id,
    title: (d.description || d.message || 'منشور فيسبوك').slice(0, 140),
    author: d.from && d.from.name,
    owner: d.from && d.from.id,
    thumb: d.picture || d.full_picture || '',
    count: (c.summary && c.summary.total_count) || 0,
  };
}
async function fbComments(id, cursor) {
  if (APIFY_TOKEN) return fbApifyComments(id);
  needFb();
  const d = await getJson(
    `https://graph.facebook.com/v19.0/${id}/comments?filter=toplevel&limit=100&fields=from,message,permalink_url&access_token=${FB_TOKEN}` +
      (cursor ? `&after=${encodeURIComponent(cursor)}` : '')
  );
  if (d.error) throw new UserError('Facebook: ' + d.error.message);
  return {
    comments: (d.data || []).map((c) => ({
      uid: (c.from && c.from.id) || c.id,
      name: (c.from && c.from.name) || 'مستخدم فيسبوك',
      text: c.message || '',
      avatar: '',
      link: c.permalink_url || '',
    })),
    next: d.paging && d.paging.next ? d.paging.cursors.after : null,
  };
}

const providers = {
  youtube: { info: ytInfo, comments: ytComments },
  tiktok: { info: ttInfo, comments: ttComments },
  facebook: { info: fbInfo, comments: fbComments },
};

// ================= HTTP =================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      try {
        if (u.pathname === '/api/ping') return send(res, 200, { ok: true });
        const p = providers[u.searchParams.get('platform')];
        if (!p) throw new UserError('منصة غير مدعومة');
        if (u.pathname === '/api/info') return send(res, 200, await p.info(u.searchParams.get('url') || ''));
        if (u.pathname === '/api/comments')
          return send(res, 200, await p.comments(u.searchParams.get('id'), u.searchParams.get('cursor')));
        return send(res, 404, { error: 'not found' });
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        return send(res, e instanceof UserError ? 400 : 500, { error: e instanceof UserError ? e.message : 'حصل خطأ غير متوقع' });
      }
    }
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
    const file = path.join(__dirname, 'docs', rel);
    if (!file.startsWith(path.join(__dirname, 'docs'))) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, buf) =>
      err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream')
    );
  })
  .listen(PORT, () => console.log(`Giveaway site running: http://localhost:${PORT}`));
