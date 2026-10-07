/**
 * @name MQ Music 统一音源
 * @description 适配MQ Music音源
 * @version 1.2.0
 * @author MingQiu
 *
 * 说明：
 *   本脚本无任何破解行为请注意分辨
 *
 * 更新记录：
 *   v1.2.0  新增酷我(kw)、酷狗(kg)的真实取链能力（此前只声明不实现）。
 *           两者都走对应平台的**官方公开接口**，免费、无需签名/卡密：
 *             - 酷我：antiserver.kuwo.cn/anti.s   实测 mp3/aac/wma 可用（flac 需权限）
 *             - 酷狗：m.kugou.com/app/i/getSongInfo.php  实测免费歌可用（付费歌返回空）
 *           在此之前 kw/kg/mg 的歌靠洛雪「自动换源」兜底到 tx/wy 才能播，
 *           一旦 tx/wy 取不到链就播不了。现在 kw/kg 有了自己的取链，不再依赖兜底。
 *   v1.1.0  初版：bilibili / QQ / 网易云 取链 + 全量声明各标准源
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx;

/* ===================== 通用工具 ===================== */
const buildQuery = (params) => {
  const parts = [];
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
};

// 请求并尝试解析 JSON（拿不到 JSON 时原样返回文本，由调用方判断）
const httpRequest = (url, headers) => new Promise((resolve, reject) => {
  request(url, { method: 'GET', timeout: 15000, headers }, (err, resp) => {
    if (err) return reject(err);
    let body = resp.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { /* 不是 JSON，保持字符串 */ }
    }
    resolve(body);
  });
});

const httpGetJson = (url, headers) => httpRequest(url, headers).then((body) => {
  if (body && typeof body === 'object') return body;
  throw new Error('响应不是 JSON');
});

// 取纯文本（酷我 antiserver 返回的就是一行 URL 文本）
const httpGetText = (url, headers) => httpRequest(url, headers).then((body) => {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && body.url) return body.url;
  return '';
});

const isValidUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:/i.test(url)) return false;
  if (url.length > 2048) return false;
  if (url.includes('404') || url.includes('error') || url.includes('null')) return false;
  return true;
};

/* ===================== 哔哩哔哩取链 ===================== */
const BILI_API = 'https://api.bilibili.com';
const BILI_UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BILI_UA_MEDIA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1';

const BILI_AUDIO_PREFER = {
  '128k': [30232, 30216, 30280, 30251, 30250],
  '320k': [30280, 30232, 30251, 30250, 30216],
  flac: [30251, 30250, 30280, 30232, 30216],
  flac24bit: [30251, 30250, 30280, 30232, 30216],
};

const isMcdn = (url) => /\.mcdn\.bilivideo\./.test(url);
const buildReferer = (bvid) => `https://www.bilibili.com/video/${bvid}`;

const dashAudioCandidates = (playData, quality) => {
  const d = playData && playData.data;
  if (!d || !d.dash) return [];
  let pool = [];
  if (d.dash.audio) pool = pool.concat(d.dash.audio);
  if (d.dash.flac && d.dash.flac.audio) pool = pool.concat(d.dash.flac.audio);
  if (d.dash.dolby && d.dash.dolby.audio) pool = pool.concat(d.dash.dolby.audio);
  if (!pool.length) return [];

  const seen = new Set();
  const audios = [];
  for (const a of pool) {
    if (!a || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    audios.push(a);
  }
  const byId = {};
  for (const a of audios) byId[a.id] = a;

  const used = new Set();
  const ordered = [];
  for (const id of (BILI_AUDIO_PREFER[quality] || BILI_AUDIO_PREFER['128k'])) {
    if (byId[id] && !used.has(id)) { used.add(id); ordered.push(byId[id]); }
  }
  for (const a of audios.slice().sort((x, y) => y.bandwidth - x.bandwidth)) {
    if (!used.has(a.id)) { used.add(a.id); ordered.push(a); }
  }

  const out = [];
  for (const a of ordered) {
    const urls = [a.baseUrl].concat(a.backupUrl || []);
    for (const url of urls) {
      if (url) out.push({ url, kind: isMcdn(url) ? 'mcdn' : 'dash', id: a.id });
    }
  }
  return out;
};

const html5Urls = (playData) => {
  const d = playData && playData.data;
  if (!d || !d.durl || !d.durl.length) return [];
  const out = [];
  for (const one of d.durl) {
    for (const url of [one.url].concat(one.backup_url || [])) {
      if (url) out.push({ url, kind: 'html5' });
    }
  }
  return out;
};

const resolveBilibiliUrl = async (bvid, quality) => {
  if (!bvid) throw new Error('缺少视频 bvid');
  const ref = buildReferer(bvid);
  const apiHeaders = { 'User-Agent': BILI_UA_DESKTOP, Accept: 'application/json', Referer: ref };
  const h5Headers = { 'User-Agent': BILI_UA_MEDIA, Accept: 'application/json', Referer: ref };

  const view = await httpGetJson(`${BILI_API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, apiHeaders);
  if (!view || view.code !== 0 || !view.data) {
    throw new Error(`获取视频信息失败：${(view && view.message) || ''}`);
  }
  const cid = view.data.cid;

  const dashData = await httpGetJson(`${BILI_API}/x/player/playurl?${buildQuery({
    bvid, cid, fnval: 16, fnver: 0, fourk: 1, qn: 120,
  })}`, apiHeaders);

  let h5Data = null;
  try {
    h5Data = await httpGetJson(`${BILI_API}/x/player/playurl?${buildQuery({
      bvid, cid, fnval: 1, fnver: 0, qn: 64, platform: 'html5', high_quality: 1,
    })}`, h5Headers);
  } catch (e) { h5Data = null; }

  const dash = dashAudioCandidates(dashData, quality);
  const h5 = html5Urls(h5Data);

  const order = [];
  const seenUrls = new Set();
  const push = (u) => {
    if (!u || !u.url || u.url.length > 2048 || seenUrls.has(u.url)) return;
    seenUrls.add(u.url);
    order.push(u);
  };
  for (const d of dash) if (d.kind === 'mcdn') push(d);
  for (const d of dash) if (d.kind !== 'mcdn') push(d);
  for (const h of h5) push(h);

  if (!order.length) throw new Error('未获取到音频流地址');
  return order[0].url;
};

/* ===================== 酷我取链 =====================
 *
 * 走酷我官方公开接口 antiserver.kuwo.cn/anti.s。
 * 实测（2026-10-07）：完全免费、无需签名、无需任何 Cookie。
 *   mp3 → https://kw-er.kuwo.cn/.../xxx.mp3   （206 + audio/mpeg，可播）
 *   aac → .../xxx.m4a
 *   wma → ...
 *   flac → 返回 "refuse request!"（需要版权/会员，公开接口拿不到）
 *
 * 所以 flac 做「先试 flac、失败回退 mp3」的处理，
 * 保证用户点了无损也能听到东西，而不是直接报错。
 */
const KW_ANTI = 'http://antiserver.kuwo.cn/anti.s';
const KW_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'http://www.kuwo.cn/',
};

const kwFetchFormat = async (rid, format) => {
  const url = `${KW_ANTI}?type=convert_url&rid=MUSIC_${rid}&format=${format}&response=url`;
  const text = (await httpGetText(url, KW_HEADERS)).trim();
  return /^https?:\/\//i.test(text) ? text : '';
};

const resolveKuwoUrl = async (rawId, quality) => {
  // 洛雪传的 songmid 可能是 "158702" 或 "MUSIC_158702"，统一取数字部分
  const rid = String(rawId || '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(rid)) throw new Error('酷我歌曲 ID 非法：' + rawId);

  if (quality === 'flac' || quality === 'flac24bit') {
    const flac = await kwFetchFormat(rid, 'flac');
    if (flac) return flac;
    // flac 拿不到（多数情况）→ 回退 mp3，至少能播
  }
  const mp3 = await kwFetchFormat(rid, 'mp3');
  if (mp3) return mp3;
  throw new Error('酷我取链失败（可能无版权或已下架）');
};

/* ===================== 酷狗取链 =====================
 *
 * 走酷狗官方公开接口 m.kugou.com/app/i/getSongInfo.php。
 * 实测（2026-10-07）：
 *   privilege=0 && pay_type=0 的免费歌 → 返回 sharefs.kugou.com 的真实 mp3（206 可播）
 *   privilege=10 / pay_type=3 的付费歌 → url 为空
 * 所以区分「付费拿不到」和「取链失败」，给用户更准确的提示。
 *
 * 注：洛雪里酷狗的 songmid 就是歌的 hash。
 */
const KG_SONGINFO = 'http://m.kugou.com/app/i/getSongInfo.php';
const KG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const resolveKugouUrl = async (hash) => {
  const h = String(hash || '').trim();
  if (!h) throw new Error('缺少酷狗歌曲 hash');
  const resp = await httpGetJson(`${KG_SONGINFO}?cmd=playInfo&hash=${encodeURIComponent(h)}`, KG_HEADERS);
  const url = resp && resp.url;
  if (isValidUrl(url)) return url;

  // 歌存在但没给地址 —— 基本都是付费/版权限制
  if (resp && resp.songName) {
    throw new Error(`酷狗《${resp.songName}》需付费/无版权，暂无法取链`);
  }
  throw new Error('酷狗取链失败');
};

/* ===================== QQ音乐 / 网易云取链 ===================== */
const QQ_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';
const BR_MAP = { '128k': '128', '192k': '192', '320k': '320', 'flac': '740', 'flac24bit': '999' };

const resolveQQUrl = async (songId) => {
  const url = `https://cyapi.top/API/qq_music.php?apikey=1ffdf5733f5d538760e63d7e46ba17438d9f7b9dfc18c51be1109386fd74c3a1&type=json&mid=${songId}`;
  const resp = await httpGetJson(url, { 'User-Agent': QQ_UA, 'Accept': 'application/json' });
  const u = resp && (resp.url || (resp.data && resp.data.url));
  if (!isValidUrl(u)) throw new Error('QQ音乐取链失败');
  return u;
};

const resolveNetEaseUrl = async (songId, quality) => {
  const br = BR_MAP[quality] || '320';
  const url = `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${songId}&br=${br}`;
  const resp = await httpGetJson(url, { 'User-Agent': QQ_UA, 'Accept': 'application/json' });
  const u = resp && (resp.url || (resp.data && resp.data.url));
  if (!isValidUrl(u)) throw new Error('网易云取链失败（该歌曲可能无版权）');
  return u;
};

/* ===================== 统一入口 ===================== */
const getMusicUrl = async (source, musicInfo, quality) => {
  const songId = (musicInfo.songmid || musicInfo.hash || musicInfo.id || musicInfo.songId || '').toString().trim();
  if (!songId) throw new Error('缺少歌曲 ID');

  switch (source) {
    case 'bilibili':
      return resolveBilibiliUrl(songId, quality);
    case 'tx':
      return resolveQQUrl(songId);
    case 'wy':
      return resolveNetEaseUrl(songId, quality);
    case 'kw':
      return resolveKuwoUrl(songId, quality);
    case 'kg':
      return resolveKugouUrl(songId);
    default:
      throw new Error('不支持的音源: ' + source);
  }
};

// 注册请求事件
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject('不支持的 action');
  return getMusicUrl(source, info.musicInfo, info.type)
    .catch(e => Promise.reject(e.message || '获取播放链接失败'));
});

// 初始化：声明全部标准源。
// 关键：洛雪通过 qualityList 判断歌曲是否「可播放/变灰」，而 qualityList 由
// inited 里声明的 sources 决定。这里把 mg 也声明出来（取链暂未实现），
// 这样咪咕的搜索结果不会变灰；点播时由洛雪的自动换源机制兜底到已实现的源。
// kw / kg 现在有真实取链，命中时不再需要兜底。
send(EVENT_NAMES.inited, {
  sources: {
    kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    kg: { name: '酷狗音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    mg: { name: '咪咕音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    bilibili: { name: '哔哩哔哩', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
  },
});
