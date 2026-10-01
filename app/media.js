/* Общие правила типов роликов. Явный выбор автора важнее ориентации файла. */
'use strict';
const Media = (() => {
  const SHORT_MAX_SECONDS = 180;
  function isShort(video) {
    if (video.contentType === 'short') return true;
    if (video.contentType === 'video') return false;
    // Совместимость с уже импортированными роликами: ничего не удаляем из базы.
    return Number(video.w) > 0 && Number(video.h) >= Number(video.w)
      && Number(video.duration) > 0 && Number(video.duration) <= SHORT_MAX_SECONDS;
  }
  function inferType(meta) { return isShort(meta) ? 'short' : 'video'; }
  function parseYouTubeLink(value) {
    const text = String(value || '').trim();
    const valid = (id) => /^[a-zA-Z0-9_-]{11}$/.test(id || '');
    if (valid(text)) return { videoId: text, short: false };
    try {
      const url = new URL(text);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
      const host = url.hostname.toLowerCase();
      const path = url.pathname.split('/').filter(Boolean);
      let id, short = false;
      if (host === 'youtu.be') id = path[0];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
        'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
        if (['shorts', 'embed', 'live'].includes(path[0])) {
          id = path[1]; short = path[0] === 'shorts';
        } else if (path[0] === 'watch') id = url.searchParams.get('v');
      }
      return valid(id) ? { videoId: id, short } : null;
    } catch (_) { return null; }
  }
  function httpsURL(value, base) {
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) { return ''; }
  }
  function instanceURL(value) {
    const url = new URL(String(value || '').trim());
    if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) || url.hostname.endsWith('.localhost')) {
      throw new Error('Укажите доступный HTTPS-адрес сервера, не localhost устройства.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Укажите HTTPS-адрес сервера без пароля, параметров и #.');
    }
    return url.href.replace(/\/+$/, '');
  }
  return { SHORT_MAX_SECONDS, isShort, inferType, parseYouTubeLink, httpsURL, instanceURL };
})();
if (typeof module !== 'undefined') module.exports = Media;
