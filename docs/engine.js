// Browser-side version of server.js, used when the site is hosted statically (GitHub Pages).
// API keys live in this browser's localStorage (entered via the ⚙️ settings), never in the repo.
const Engine = (() => {
  class UserError extends Error {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keys = () => { // built-in keys (config.js), overridden by anything saved in ⚙️ settings
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('giveaway_keys') || '{}'); } catch {}
    const base = (typeof window !== 'undefined' && window.GIVEAWAY_KEYS) || {}, out = { ...base };
    for (const k in saved) if (saved[k] && String(saved[k]).trim()) out[k] = saved[k];
    return out;
  };
  const need = (k, label) => { const v = (keys()[k] || '').trim(); if (!v) throw new UserError(`${label} غير مضبوط. افتح ⚙️ الإعدادات وضع المفتاح`); return v; };
  const getJson = async (url, opt) => {
    let r;
    try { r = await fetch(url, opt); } catch { throw new UserError('تعذر الاتصال بالمنصة، تأكد من الإنترنت'); }
    try { return await r.json(); } catch { throw new UserError('رد غير متوقع من المنصة'); }
  };

  // ---------- YouTube ----------
  const ytId = (url) => { const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([A-Za-z0-9_-]{11})/); return m && m[1]; };
  async function ytInfo(url) {
    const key = need('youtube', 'مفتاح يوتيوب');
    const id = ytId(url);
    if (!id) throw new UserError('رابط يوتيوب غير صحيح');
    const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${id}&key=${encodeURIComponent(key)}`);
    if (d.error) throw new UserError('YouTube: ' + d.error.message);
    const v = d.items && d.items[0];
    if (!v) throw new UserError('الفيديو غير موجود أو خاص');
    const t = v.snippet.thumbnails;
    return { id, title: v.snippet.title, author: v.snippet.channelTitle, owner: v.snippet.channelId, thumb: (t.maxres || t.high || t.medium || t.default).url, count: Number(v.statistics.commentCount || 0) };
  }
  async function ytComments(id, cursor) {
    const key = need('youtube', 'مفتاح يوتيوب');
    const d = await getJson(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=100&order=time&textFormat=plainText&key=${encodeURIComponent(key)}` + (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''));
    if (d.error) throw new UserError('YouTube: ' + d.error.message);
    return {
      comments: (d.items || []).map((i) => {
        const s = i.snippet.topLevelComment.snippet;
        return { uid: (s.authorChannelId && s.authorChannelId.value) || s.authorDisplayName, name: s.authorDisplayName, text: s.textDisplay, avatar: s.authorProfileImageUrl, link: `https://www.youtube.com/watch?v=${id}&lc=${i.id}` };
      }),
      next: d.nextPageToken || null,
    };
  }

  // ---------- TikTok (unofficial tikwm.com, no key) ----------
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
  // ---------- Facebook (Apify) ----------
  async function fbInfo(url) {
    need('apify', 'توكن Apify');
    if (!/facebook\.com|fb\.watch|fb\.com/.test(url)) throw new UserError('رابط فيسبوك غير صحيح');
    return { id: url, title: 'فيديو فيسبوك', author: '', owner: '', thumb: '', count: 0 };
  }
  async function fbComments(url, _cursor, onProgress) {
    const token = encodeURIComponent(need('apify', 'توكن Apify'));
    const api = 'https://api.apify.com/v2';
    // start the run asynchronously so we can report progress while it scrapes
    const run = await getJson(`${api}/acts/apify~facebook-comments-scraper/runs?token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], resultsLimit: 1000, includeNestedComments: false, viewOption: 'RANKED_UNFILTERED' }),
    });
    if (!run.data) throw new UserError(apifyMsg(run.error && run.error.message));
    const runId = run.data.id, ds = run.data.defaultDatasetId, t0 = Date.now();
    for (;;) {
      await sleep(2000);
      const [st, d] = await Promise.all([getJson(`${api}/actor-runs/${runId}?token=${token}`), getJson(`${api}/datasets/${ds}?token=${token}`)]);
      if (onProgress && d.data) onProgress(d.data.itemCount || 0);
      const status = st.data && st.data.status;
      if (status === 'SUCCEEDED') break;
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new UserError('Apify: فشل الجلب (' + status + ')، تأكد من الرابط والرصيد');
      if (Date.now() - t0 > 290000) throw new UserError('Apify: استغرق الجلب وقتاً طويلاً، جرّب مرة أخرى');
    }
    const items = await getJson(`${api}/datasets/${ds}/items?token=${token}&clean=1`);
    if (!Array.isArray(items)) throw new UserError('Apify: تعذر قراءة النتائج');
    return {
      comments: items.filter((c) => c.text && !(c.threadingDepth > 0)).map((c) => ({ uid: c.profileId || c.profileUrl || c.profileName, name: c.profileName || 'مستخدم فيسبوك', text: c.text, avatar: c.profilePicture || '', link: c.commentUrl || '' })),
      next: null,
    };
  }

  const P = { youtube: { info: ytInfo, comments: ytComments }, tiktok: { info: ttInfo, comments: ttComments }, facebook: { info: fbInfo, comments: fbComments } };
  return {
    info: (platform, url) => P[platform].info(url),
    comments: (platform, id, cursor, onProgress) => P[platform].comments(id, cursor, onProgress),
  };
})();
if (typeof module !== 'undefined') module.exports = Engine;
