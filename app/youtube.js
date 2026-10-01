/* Настоящие сетевые источники. Никаких демо-результатов, общих ключей или
   случайных публичных прокси. API-ключ / адрес своего сервера задаёт пользователь. */
'use strict';
const YouTube = (() => {
  let options = { provider: 'official', apiKey: '', instance: '', offline: false, proxyPlayback: true };
  const requests = new Set();
  const validId = (id) => /^[a-zA-Z0-9_-]{11}$/.test(id || '');

  function stop() { requests.forEach((controller) => controller.abort()); requests.clear(); }
  function configure(config) {
    stop();
    options = { ...options, ...config };
  }
  function configured() {
    return options.provider === 'invidious' ? !!options.instance : !!options.apiKey;
  }
  function required() {
    if (options.offline) throw new Error('Офлайн-режим: доступны только видео на устройстве.');
    if (!configured()) throw new Error(options.provider === 'invidious'
      ? 'Укажите адрес своего HTTPS-сервера Invidious в настройках.'
      : 'Для поиска и ленты добавьте свой ключ YouTube Data API v3 в настройках. По ссылке можно смотреть без ключа.');
  }

  async function request(url, signal) {
    if (options.offline) throw new Error('Сеть отключена в офлайн-режиме.');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', cancel, { once: true });
    requests.add(controller);
    const timeout = setTimeout(cancel, 18000);
    try {
      // В APK нативный HTTPS-клиент решает CORS, но принимает только разрешённые API.
      // В PWA сервер Invidious должен разрешать CORS для origin приложения.
      let data;
      if (window.NativeApp?.requestJson) {
        data = await window.NativeApp.requestJson(url, controller.signal);
      } else {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit',
          referrerPolicy: 'strict-origin-when-cross-origin' });
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('Слишком большой ответ сервера.');
        try { data = JSON.parse(text); } catch (_) { throw new Error('Сервер вернул не JSON. Проверьте адрес и доступность API.'); }
        if (!response.ok) {
          const code = data?.error?.errors?.[0]?.reason;
          if (code === 'quotaExceeded' || code === 'dailyLimitExceeded') throw new Error('Исчерпана квота ключа YouTube API.');
          if (response.status === 403) throw new Error('Доступ к API запрещён. Проверьте ключ, включение YouTube Data API v3 и его ограничения.');
          throw new Error('Ошибка API: HTTP ' + response.status + '. Проверьте выбранный сервер.');
        }
      }
      if (controller.signal.aborted || options.offline) throw new DOMException('Aborted', 'AbortError');
      if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : 'Ошибка YouTube API.');
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted || options.offline) throw new DOMException('Aborted', 'AbortError');
        throw new Error('Сервер не ответил вовремя. Проверьте сеть или настройте другой источник.');
      }
      if (error instanceof TypeError) throw new Error('Нет доступа к серверу. Возможны блокировка, отсутствие сети или CORS. Локальные видео остаются доступны.');
      throw error;
    } finally {
      clearTimeout(timeout); requests.delete(controller); signal?.removeEventListener('abort', cancel);
    }
  }

  function officialURL(endpoint, params) {
    const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
    for (const [key, value] of Object.entries({ ...params, key: options.apiKey })) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    return url.href;
  }
  function instanceAPI(endpoint, params = {}) {
    const url = new URL(Media.instanceURL(options.instance) + '/api/v1/' + endpoint);
    for (const [key, value] of Object.entries({ hl: 'ru', ...params })) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    return url.href;
  }
  function durationISO(text) {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(text || '');
    return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
  }
  function normalizeOfficial(item) {
    const videoId = typeof item.id === 'string' ? item.id : item.id?.videoId;
    if (!validId(videoId)) return null;
    const snippet = item.snippet || {};
    const thumbs = snippet.thumbnails || {};
    return {
      id: 'yt:' + videoId, videoId, source: 'youtube', contentType: 'video',
      title: snippet.title || 'YouTube', channelName: snippet.channelTitle || 'YouTube',
      channelId: snippet.channelId || '', description: snippet.description || '',
      createdAt: Date.parse(snippet.publishedAt) || 0, views: Number(item.statistics?.viewCount) || 0,
      likes: Number(item.statistics?.likeCount) || 0, duration: durationISO(item.contentDetails?.duration),
      thumbRemote: Media.httpsURL((thumbs.maxres || thumbs.high || thumbs.medium || thumbs.default)?.url),
      live: snippet.liveBroadcastContent === 'live'
    };
  }
  function normalizeInvidious(item) {
    if (!validId(item.videoId)) return null;
    const thumb = (item.videoThumbnails || []).find((t) => t.quality === 'medium') || item.videoThumbnails?.[0];
    const avatar = item.authorThumbnails?.[0];
    return {
      id: 'yt:' + item.videoId, videoId: item.videoId, source: 'youtube',
      // shortVideo в API Invidious — компактная запись, не обязательный признак Shorts.
      contentType: item.isShort === true || item.isShorts === true || item.type === 'shorts' ? 'short' : 'video',
      title: item.title || 'YouTube', channelName: item.author || 'YouTube', channelId: item.authorId || '',
      description: item.description || '', createdAt: Number(item.published) * 1000 || 0,
      publishedText: item.publishedText || '', views: Number(item.viewCount) || 0,
      likes: Number(item.likeCount) || 0, duration: Number(item.lengthSeconds) || 0,
      thumbRemote: Media.httpsURL(thumb?.url, options.instance),
      avatarRemote: Media.httpsURL(avatar?.url, options.instance), live: !!item.liveNow
    };
  }
  async function details(ids, signal) {
    if (!ids.length) return [];
    const data = await request(officialURL('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') }), signal);
    return (data.items || []).map(normalizeOfficial).filter(Boolean);
  }
  async function trending(signal) {
    required();
    if (options.provider === 'invidious') {
      const data = await request(instanceAPI('trending', { region: 'US' }), signal);
      if (!Array.isArray(data)) throw new Error('Неверный ответ Invidious.');
      return data.map(normalizeInvidious).filter(Boolean);
    }
    const data = await request(officialURL('videos', { part: 'snippet,contentDetails,statistics', chart: 'mostPopular',
      regionCode: 'US', maxResults: 24 }), signal);
    return (data.items || []).map(normalizeOfficial).filter(Boolean);
  }
  async function search(query, signal, page = '') {
    required();
    if (options.provider === 'invidious') {
      const pageNum = Math.max(1, Number(page) || 1);
      const data = await request(instanceAPI('search', { q: query, type: 'video', page: pageNum }), signal);
      if (!Array.isArray(data)) throw new Error('Неверный ответ Invidious.');
      const items = data.filter((v) => ['video', 'shortVideo', 'shorts'].includes(v.type)).map(normalizeInvidious).filter(Boolean);
      return { items, nextPage: data.length >= 20 ? String(pageNum + 1) : '' };
    }
    const data = await request(officialURL('search', { part: 'snippet', q: query, type: 'video',
      videoEmbeddable: 'true', maxResults: 20, pageToken: page }), signal);
    const ids = (data.items || []).map((v) => v.id?.videoId).filter(validId);
    return { items: await details(ids, signal), nextPage: data.nextPageToken || '' };
  }
  async function video(videoId, signal, short = false) {
    if (!validId(videoId)) throw new Error('Некорректный ID видео YouTube.');
    if (options.provider === 'invidious') {
      required();
      const data = await request(instanceAPI('videos/' + videoId, { local: options.proxyPlayback ? 'true' : 'false' }), signal);
      const item = normalizeInvidious(data);
      if (!item) throw new Error('Видео не найдено.');
      if (short) item.contentType = 'short';
      return { item, stream: streamURL(data.formatStreams || []),
        recommendations: (data.recommendedVideos || []).map(normalizeInvidious).filter(Boolean) };
    }
    if (options.apiKey) {
      const items = await details([videoId], signal);
      if (!items.length) throw new Error('Видео удалено, скрыто или недоступно для этого ключа API.');
      if (short) items[0].contentType = 'short';
      return { item: items[0], stream: '', recommendations: [] };
    }
    // oEmbed — официальный запрос метаданных по ссылке, без API-ключа.
    const url = new URL('https://www.youtube.com/oembed');
    url.searchParams.set('url', 'https://www.youtube.com/watch?v=' + videoId);
    url.searchParams.set('format', 'json');
    const data = await request(url.href, signal);
    return { item: {
      id: 'yt:' + videoId, videoId, source: 'youtube', contentType: short ? 'short' : 'video',
      title: data.title || 'Видео YouTube', channelName: data.author_name || 'YouTube',
      thumbRemote: Media.httpsURL(data.thumbnail_url), description: '', createdAt: 0, duration: 0, views: 0, likes: 0
    }, stream: '', recommendations: [] };
  }
  function streamURL(formats) {
    // Только готовые потоки с аудио И видео. Adaptive/DASH нельзя проигрывать как MP4.
    const formatsMP4 = formats.filter((f) => (f.type || '').startsWith('video/mp4') || f.container === 'mp4')
      .sort((a, b) => (parseInt(b.qualityLabel || b.resolution) || 0) - (parseInt(a.qualityLabel || a.resolution) || 0));
    for (const format of formatsMP4) {
      const safe = Media.httpsURL(format.url, options.instance);
      if (!safe) continue;
      const url = new URL(safe);
      const base = new URL(Media.instanceURL(options.instance));
      if (options.proxyPlayback && url.hostname.endsWith('.googlevideo.com')) {
        return base.href.replace(/\/+$/, '') + '/videoplayback' + url.search;
      }
      if (!options.proxyPlayback || url.origin === base.origin) return safe;
    }
    return '';
  }
  function embedURL(videoId) {
    if (!validId(videoId)) return '';
    const base = options.provider === 'invidious' ? Media.instanceURL(options.instance) : 'https://www.youtube-nocookie.com';
    const url = new URL(base + '/embed/' + videoId);
    url.searchParams.set('autoplay', '1'); url.searchParams.set('playsinline', '1'); url.searchParams.set('hl', 'ru');
    if (options.provider === 'invidious') url.searchParams.set('local', options.proxyPlayback ? 'true' : 'false');
    else {
      url.searchParams.set('enablejsapi', '1'); url.searchParams.set('origin', location.origin);
      url.searchParams.set('rel', '0');
    }
    return url.href;
  }
  return { configure, configured, stop, trending, search, video, embedURL, durationISO, normalizeOfficial, normalizeInvidious };
})();
