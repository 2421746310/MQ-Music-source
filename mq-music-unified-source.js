/**
 * @name MQ Music 统一音源
 * @description B站 + QQ音乐 + 网易云 三平台取链（后端实测可用）
 * @version 1.1.0
 * @author MingQiu
 *
 * 说明：
 *   本脚本合并了三个平台的取链，导入一次即可播放 B站 / QQ音乐 / 网易云。
 *   - 哔哩哔哩：搜索由软件内置，取链走 B 站官方 playurl 接口（需软件内置的 UA/Referer 注入）
 *   - QQ音乐：cyapi.top（返回 stream.qqmusic.qq.com 直链）
 *   - 网易云：music-api.gdstudio.xyz（返回 music.126.net 直链）
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

const httpGetJson = (url, headers) => new Promise((resolve, reject) => {
  request(url, { method: 'GET', timeout: 15000, headers }, (err, resp) => {
    if (err) return reject(err);
    let body = resp.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { return reject(new Error('响应不是 JSON')); }
    }
    resolve(body);
  });
});

// 提取 URL：兼容字符串 / {url} / {data:{url}} 三种返回
const extractUrl = (resp) => {
  const body = resp.body;
  if (!body) return null;
  if (typeof body === 'string') {
    try {
      const j = JSON.parse(body);
      if (j.url) return j.url;
      if (j.data && j.data.url) return j.data.url;
    } catch (e) { /* 不是 JSON，走正则 */ }
    const m = body.match(/https?:\/\/[^\s<>"']+/);
    return m ? m[0] : null;
  }
  if (typeof body === 'object') {
    if (body.url) return body.url;
    if (body.data && body.data.url) return body.data.url;
  }
  return null;
};

const isValidUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:/.test(url)) return false;
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
  if (!isValidUrl(u)) throw new Error('网易云取链失败');
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

// 初始化：注册三个源
send(EVENT_NAMES.inited, {
  sources: {
    bilibili: { name: '哔哩哔哩', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    wy: { name: '网易云音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  },
});