/* ============================================================
   app.js — локальное приложение «YouTube»:
   загрузка своих видео, рекомендации в случайном порядке,
   просмотр, Shorts, комментарии — всё локально на устройстве.
   ============================================================ */

'use strict';

/* ============================== утилиты ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function trimNum(v) {
  return (Math.round(v * 10) / 10).toString().replace('.', ',');
}

function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return trimNum(n / 1000) + ' тыс.';
  return trimNum(n / 1e6) + ' млн';
}

function fmtViews(n) {
  const unit = n < 1000 ? plural(n, 'просмотр', 'просмотра', 'просмотров') : 'просмотров';
  return fmtCount(n) + ' ' + unit;
}

function fmtSubs(n) {
  return fmtCount(n) + ' ' + plural(n, 'подписчик', 'подписчика', 'подписчиков');
}

const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.'];

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()} г.`;
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} ${plural(w, 'неделю', 'недели', 'недель')} назад`;
  return fmtDate(ts);
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function icon(name, cls = '') {
  return `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;
}

function avatarHTML(name, cls = '', hue = null) {
  const letter = esc((String(name || '?').trim()[0] || '?').toUpperCase());
  const h = hue == null ? hueOf(name) : hue;
  return `<div class="avatar ${cls}" style="background:hsl(${h} 45% 42%)">${letter}</div>`;
}

/* ============================== состояние ============================== */

const S = {
  settings: {
    theme: 'light',            // light | dark | system
    channelName: 'Мой канал',
    channelColor: 262,
    autoplayNext: true,
    offlineMode: false,
    autoOffline: true,
    homeSource: 'local',
    onlineProvider: 'official',
    youtubeApiKey: '',
    invidiousInstance: '',
    proxyPlayback: true,
    subs: {}                   // channelName -> bool
  },
  videos: [],
  booted: false,
  onlineVideos: new Map(),
  onlineState: {},
  onlineSaved: [],
  networkAvailable: navigator.onLine !== false,
  searchSource: 'local',
  searchQuery: '',
  searchExecute: false,
  libraryTab: 'videos',
  lastTab: 'home',
  filter: 'all',
  channelTab: 'videos',
  shortStart: null,
  shortActive: null,
  reshuffle: false,
  _watchVisit: null
};

const thumbUrls = new Map();
const videoUrls = new Map();

function thumbURL(v) {
  if (v.source === 'youtube') return effectiveOffline() ? placeholderThumb : (v.thumbRemote || placeholderThumb);
  if (!thumbUrls.has(v.id)) {
    thumbUrls.set(v.id, v.thumb ? URL.createObjectURL(v.thumb) : '');
  }
  return thumbUrls.get(v.id);
}

function fileURL(v) {
  if (!videoUrls.has(v.id)) {
    videoUrls.set(v.id, URL.createObjectURL(v.file));
  }
  return videoUrls.get(v.id);
}

function releaseVideo(id) {
  const t = thumbUrls.get(id); if (t) { URL.revokeObjectURL(t); thumbUrls.delete(id); }
  const u = videoUrls.get(id); if (u) { URL.revokeObjectURL(u); videoUrls.delete(id); }
}

function getVideo(id) {
  return S.videos.find((v) => v.id === id) || S.onlineVideos.get(id);
}

async function reloadVideos() {
  S.videos = await DB.listVideos();
}

function isShort(v) {
  return Media.isShort(v);
}


const placeholderThumb = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#272727"/><path d="M285 135v90l80-45z" fill="#777"/></svg>');
document.addEventListener('error', (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && !image.dataset.fallback) {
    image.dataset.fallback = 'true'; image.src = placeholderThumb;
  }
}, true);
let renderGeneration = 0;
let searchGeneration = 0;
let searchController = null;

function effectiveOffline() {
  return S.settings.offlineMode || (S.settings.autoOffline && !S.networkAvailable);
}

function syncNetworkSettings() {
  const offline = effectiveOffline();
  YouTube.configure({ provider: S.settings.onlineProvider, apiKey: S.settings.youtubeApiKey,
    instance: S.settings.invidiousInstance, proxyPlayback: S.settings.proxyPlayback, offline });
  if (window.NativeApp && S.booted) window.NativeApp.setNetwork(offline, S.settings.invidiousInstance, S.settings.onlineProvider === 'invidious' && S.settings.proxyPlayback);
  navigator.serviceWorker?.controller?.postMessage({ type: 'SET_OFFLINE', enabled: offline });
  updateConnectionBanner();
}

function updateConnectionBanner() {
  const banner = $('#connection-banner');
  const offline = effectiveOffline();
  document.body.dataset.network = offline ? 'offline' : 'online';
  banner.hidden = !offline;
  banner.innerHTML = offline ? `${icon('wifi-off')}<span>${S.settings.offlineMode ? 'Офлайн-режим' : 'Нет подключения'} · Видео на устройстве</span><button data-act="open-settings">Настройки</button>` : '';
}

window.androidNetworkChanged = (available) => {
  const changed = S.networkAvailable !== !!available;
  S.networkAvailable = !!available;
  if (!S.booted) return;
  if (changed) { syncNetworkSettings(); closeSheet(); render(); } else updateConnectionBanner();
};
window.addEventListener('online', () => window.androidNetworkChanged(true));
window.addEventListener('offline', () => window.androidNetworkChanged(false));
window.addEventListener('native-ready', () => { if (S.booted) { applyTheme(); syncNetworkSettings(); render(); } });

function sourceStripHTML(source = S.settings.homeSource, search = false) {
  return `<div class="source-strip" role="tablist" aria-label="Источник видео">
    <button role="tab" aria-selected="${source === 'local' || effectiveOffline()}" class="source-button ${source === 'local' || effectiveOffline() ? 'on' : ''}"
      data-act="${search ? 'search-source' : 'source'}" data-source="local">${icon('download')}На устройстве</button>
    <button role="tab" aria-selected="${source === 'youtube' && !effectiveOffline()}" class="source-button ${source === 'youtube' && !effectiveOffline() ? 'on' : ''} ${effectiveOffline() ? 'unavailable' : ''}"
      data-act="${search ? 'search-source' : 'source'}" data-source="youtube">${icon('play', 'icon--fill')}YouTube</button>
    <button class="icon-btn" data-act="youtube-link" aria-label="Открыть ссылку YouTube">${icon('link')}</button>
  </div>`;
}

function rememberOnline(items) {
  return items.map((item) => {
    const old = S.onlineVideos.get(item.id);
    const video = { ...old, ...item, ...(S.onlineState[item.id] || {}) };
    // Ссылка /shorts/ — достовернее неполных метаданных API.
    if (old?.contentType === 'short') video.contentType = 'short';
    S.onlineVideos.set(video.id, video);
    return video;
  });
}

function navigateVideo(id) {
  const video = getVideo(id);
  if (video && isShort(video) && video.source !== 'youtube') {
    S.shortStart = id;
    if (location.hash === '#/shorts') render(); else location.hash = '#/shorts';
  } else if (video?.source === 'youtube' && isShort(video)) {
    location.hash = '#/online-short/' + video.videoId;
  } else location.hash = '#/watch/' + id;
}

function videoStats(v) {
  if (v.source === 'youtube') return [v.views ? fmtViews(v.views) : '', v.publishedText || (v.createdAt ? timeAgo(v.createdAt) : '')].filter(Boolean).join(' · ');
  return fmtViews(v.views || 0) + ' · ' + timeAgo(v.createdAt);
}

function videoAvatar(v, cls = '') {
  return v.avatarRemote && !effectiveOffline()
    ? `<img class="avatar ${cls}" src="${esc(v.avatarRemote)}" alt="" loading="lazy">`
    : avatarHTML(v.channelName, cls, v.source === 'youtube' ? null : S.settings.channelColor);
}

function skeletonHTML() {
  return `<div class="feed">${Array.from({ length: 3 }, () => `<div class="vcard"><div class="vthumb skel"></div><div class="skeleton-meta"><i class="skel"></i><div><p class="skel"></p><p class="skel"></p></div></div></div>`).join('')}</div>`;
}

function networkErrorHTML(error) {
  return emptyHTML('wifi-off', 'Не удалось подключиться', error.message || 'Проверьте сеть и выбранный источник.',
    `<button class="btn-gray" data-act="open-settings">Настроить подключение</button><button class="text-btn" data-act="source" data-source="local">Смотреть на устройстве</button>`);
}

/* ============================== тема ============================== */

const mediaTheme = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  const t = S.settings.theme || 'light';
  return t === 'system' ? (mediaTheme.matches ? 'dark' : 'light') : t;
}

function applyTheme() {
  const t = resolvedTheme();
  document.body.dataset.theme = t;
  $('#meta-theme').setAttribute('content', t === 'dark' ? '#0f0f0f' : '#ffffff');
  if (window.NativeApp) window.NativeApp.setBars(t === 'dark' || parseHash()[0] === 'shorts');
  const na = $('#nav-avatar');
  if (na) {
    na.textContent = (S.settings.channelName.trim()[0] || 'В').toUpperCase();
    na.style.background = `hsl(${S.settings.channelColor} 45% 42%)`;
  }
}

mediaTheme.addEventListener('change', () => { if (S.settings.theme === 'system') applyTheme(); });

/* ============================== toast ============================== */

let toastTimer = null;
function toast(msg) {
  const host = $('#toast-host');
  host.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ''; }, 2600);
}

/* ============================== нижние листы ============================== */

function openSheet(html) {
  $('#sheet').innerHTML = `<div class="sheet-handle"></div>` + html;
  $('#sheet-root').hidden = false;
}

function closeSheet() {
  $('#sheet-root').hidden = true;
  $('#sheet').innerHTML = '';
}

/** rows: {icon, label, danger, checked, onClick} */
function menuSheet(title, rows) {
  openSheet(`
    ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
    <div class="sheet-rows">
      ${rows.map((r, i) => `
        <button class="sheet-row ${r.danger ? 'danger' : ''}" data-mi="${i}">
          ${r.icon ? icon(r.icon, r.iconFill ? 'icon--fill' : '') : '<span class="icon"></span>'}
          <span class="sr-t">${esc(r.label)}</span>
          ${r.checked ? icon('check', 'sr-check') : ''}
        </button>`).join('')}
    </div>`);
  $$('#sheet .sheet-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = rows[+btn.dataset.mi];
      closeSheet();
      r.onClick && r.onClick();
    });
  });
}

function formSheet({ title, fields, okLabel = 'Сохранить', onOk }) {
  openSheet(`
    <div class="sheet-title">${esc(title)}</div>
    <form class="sheet-form" id="sheet-form">
      ${fields.map((f) => `
        <div>
          <label for="f-${f.name}">${esc(f.label)}</label>
          ${f.multiline
            ? `<textarea id="f-${f.name}" name="${f.name}" rows="3">${esc(f.value || '')}</textarea>`
            : `<input id="f-${f.name}" name="${f.name}" value="${esc(f.value || '')}" type="${f.type || 'text'}" autocomplete="off" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`}
        </div>`).join('')}
      <div class="sheet-btns">
        <button type="button" class="sb-cancel">Отмена</button>
        <button type="submit" class="sb-ok">${esc(okLabel)}</button>
      </div>
    </form>`);
  $('#sheet .sb-cancel').addEventListener('click', closeSheet);
  $('#sheet-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {};
    fields.forEach((f) => { data[f.name] = $(`#f-${f.name}`).value; });
    closeSheet();
    onOk(data);
  });
  const first = $('#sheet-form input, #sheet-form textarea');
  if (first) setTimeout(() => first.focus(), 250);
}

/* ============================== карточки ============================== */

function videoCardHTML(v) {
  if (isShort(v)) return shortsGridHTML([v]);
  return `<article class="vcard" data-video="${esc(v.id)}">
    <button class="vthumb" data-act="watch" data-id="${esc(v.id)}" aria-label="Смотреть: ${esc(v.title)}">
      <img src="${esc(thumbURL(v) || placeholderThumb)}" alt="" loading="lazy">
      ${v.live ? '<span class="dur live">В ЭФИРЕ</span>' : v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ''}
    </button>
    <div class="vmeta">
      ${videoAvatar(v)}
      <div class="vtext" data-act="watch" data-id="${esc(v.id)}">
        <h3 class="vtitle">${esc(v.title)}</h3>
        <div class="vsub">${esc(v.channelName)}${videoStats(v) ? ' · ' + esc(videoStats(v)) : ''}</div>
      </div>
      <button class="vmore" data-act="card-menu" data-id="${esc(v.id)}" aria-label="Действия с видео">${icon('more-v', 'icon--fill')}</button>
    </div>
  </article>`;
}

function compactCardHTML(v) {
  const short = isShort(v);
  return `<article class="ccard ${short ? 'short-ccard' : ''}">
    <button class="cthumb" data-act="watch" data-id="${esc(v.id)}" aria-label="Смотреть: ${esc(v.title)}">
      <img src="${esc(thumbURL(v) || placeholderThumb)}" alt="" loading="lazy">
      ${short ? `<span class="short-badge">${icon('shorts', 'icon--fill')}Shorts</span>` : v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ''}
    </button>
    <div class="ctext" data-act="watch" data-id="${esc(v.id)}">
      <h3 class="ctitle">${esc(v.title)}</h3>
      <div class="csub">${esc(v.channelName)}${videoStats(v) ? ' · ' + esc(videoStats(v)) : ''}</div>
    </div>
    <button class="vmore" data-act="card-menu" data-id="${esc(v.id)}" aria-label="Действия с видео">${icon('more-v', 'icon--fill')}</button>
  </article>`;
}

function shortsShelfHTML(items) {
  return `<section class="shorts-shelf">
    <div class="shelf-head">${icon('shorts', 'shorts-logo icon--fill')}<h2>Shorts</h2><div class="tb-grow"></div>
      <button class="icon-btn" data-act="upload-video" data-type="short" aria-label="Добавить Shorts">${icon('plus')}</button>
    </div>
    <div class="shelf-scroll">${items.map((v) => `<button class="shorts-tile" data-act="open-shorts" data-id="${esc(v.id)}" aria-label="Смотреть Shorts: ${esc(v.title)}">
      <img src="${esc(thumbURL(v) || placeholderThumb)}" alt="" loading="lazy">
      <span class="st-title">${esc(v.title)}</span><span class="st-views">${fmtViews(v.views || 0)}</span>
    </button>`).join('')}</div>
  </section>`;
}

function shortsGridHTML(items) {
  return `<div class="shorts-grid">${items.map((v) => `<article class="sg-card">
    <button class="sg-thumb" data-act="open-shorts" data-id="${esc(v.id)}" aria-label="Смотреть Shorts: ${esc(v.title)}">
      <img src="${esc(thumbURL(v) || placeholderThumb)}" alt="" loading="lazy">${icon('shorts', 'sg-badge icon--fill')}
    </button>
    <div class="sg-meta"><div data-act="open-shorts" data-id="${esc(v.id)}"><h3>${esc(v.title)}</h3><p>${fmtViews(v.views || 0)}</p></div>
      <button class="vmore" data-act="card-menu" data-id="${esc(v.id)}" aria-label="Действия с Shorts">${icon('more-v', 'icon--fill')}</button>
    </div>
  </article>`).join('')}</div>`;
}

function emptyHTML(iconName, title, text, btn = '') {
  return `
  <div class="empty">
    ${icon(iconName)}
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${btn}
  </div>`;
}

function feedHTML(list) {
  return `<div class="feed">${list.map(videoCardHTML).join('')}</div>`;
}

/* ============================== верхние панели ============================== */

function ytLogoHTML() {
  return `
  <div class="yt-logo" data-act="tab" data-tab="home">
    <svg class="yt-logo-badge" viewBox="0 0 30 21" aria-hidden="true">
      <rect x="0" y="0" width="30" height="21" rx="5.5" fill="#FF0000"/>
      <path d="M12 5.8 19.2 10.5 12 15.2z" fill="#fff"/>
    </svg>
    <span class="yt-logo-word">YouTube</span>
  </div>`;
}

function topMainHTML() {
  return `
  <div class="tb-row">
    ${ytLogoHTML()}
    <div class="tb-grow"></div>
    <form id="desktop-search" class="desktop-search" role="search"><input id="desktop-query" aria-label="Поиск видео" placeholder="Введите запрос" autocomplete="off"><button type="submit" aria-label="Найти">${icon('search')}</button></form>
    <button class="icon-btn" data-act="cast" aria-label="Трансляция">${icon('cast')}</button>
    <button class="icon-btn" data-act="notifications" aria-label="Уведомления">${icon('bell')}</button>
    <button class="icon-btn mobile-search-btn" data-act="open-search" aria-label="Поиск">${icon('search')}</button>
  </div>`;
}

function topSearchHTML(query = '') {
  return `
  <div class="tb-search-row">
    <button class="icon-btn" data-act="back" aria-label="Назад">${icon('back')}</button>
    <div class="search-input-wrap">
      <input id="search-input" type="search" value="${esc(query)}" placeholder="Введите запрос" autocomplete="off">
      <button class="icon-btn" data-act="search-clear" aria-label="Очистить">${icon('close')}</button>
    </div>
    <button class="icon-btn" data-act="mic" aria-label="Голос">${icon('mic')}</button>
  </div>`;
}

function topTitleHTML(title) {
  return `
  <div class="tb-row">
    <button class="icon-btn" data-act="back" aria-label="Назад">${icon('back')}</button>
    <div class="tb-title-text">${esc(title)}</div>
    <div class="tb-grow"></div>
    <button class="icon-btn" data-act="open-search" aria-label="Поиск">${icon('search')}</button>
  </div>`;
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'desktop-search') return;
  event.preventDefault();
  const query = $('#desktop-query').value.trim();
  if (!query) return;
  S.searchQuery = query; S.searchSource = effectiveOffline() ? 'local' : S.settings.homeSource;
  S.searchExecute = true; location.hash = '#/search';
});

/* ============================== глобальные клики ============================== */

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.dataset.id;

  switch (act) {
    case 'tab':
      onTab(t.dataset.tab);
      break;
    case 'watch':
      navigateVideo(id);
      break;
    case 'open-shorts':
      navigateVideo(id);
      break;
    case 'open-search':
      S.searchSource = effectiveOffline() ? 'local' : S.settings.homeSource;
      location.hash = '#/search';
      break;
    case 'back':
      if (history.length > 1) history.back(); else location.hash = '#/home';
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'card-menu':
      videoMenu(id);
      break;
    case 'cast':
      toast('Для трансляции откройте видео в официальном приложении YouTube. Локальная трансляция пока не поддерживается.');
      break;
    case 'mic':
      toast('Голосовой поиск недоступен офлайн');
      break;
    case 'upload':
      openCreateMenu();
      break;
    case 'upload-video':
      openUpload(t.dataset.type || 'auto');
      break;
    case 'chip':
      S.filter = t.dataset.chip;
      render();
      break;
    case 'like': toggleLike(id); break;
    case 'dislike': toggleDislike(id); break;
    case 'save': toggleSave(id); break;
    case 'share': shareVideo(id); break;
    case 'download': downloadVideo(id); break;
    case 'card-edit': editVideo(id); break;
    case 'card-delete': confirmDelete(id); break;
    case 'sub': toggleSub(t.dataset.ch); break;
    case 'desc-toggle': {
      const b = $('.d-body');
      if (b) { b.classList.toggle('clamp'); b.closest('.w-desc')?.classList.toggle('expanded', !b.classList.contains('clamp')); }
      break;
    }
    case 'comments-toggle': {
      const blk = $('#full-comments');
      if (blk) {
        blk.hidden = !blk.hidden;
        if (!blk.hidden) blk.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      break;
    }
    case 'send-comment': sendComment(); break;
    case 'del-comment': delComment(id); break;
    case 'open-history': location.hash = '#/history'; break;
    case 'open-my-videos': location.hash = '#/my-videos'; break;
    case 'open-watch-later': location.hash = '#/watch-later'; break;
    case 'open-settings': location.hash = '#/settings'; break;
    case 'open-channel': location.hash = '#/channel/' + encodeURIComponent(t.dataset.ch); break;
    case 'theme': setTheme(t.dataset.themeV); break;
    case 'toggle-autoplay': toggleAutoplay(); break;
    case 'edit-channel': editChannel(); break;
    case 'clear-history': confirmClearHistory(); break;
    case 'wipe-all': confirmWipe(); break;
    case 'search-clear': {
      const inp = $('#search-input');
      if (inp) { inp.value = ''; S.searchQuery = ''; inp.focus(); renderSearchBody(''); }
      break;
    }
    case 'search-run':
      runSearch(t.dataset.q);
      break;
    case 'source': setSource(t.dataset.source); break;
    case 'search-source': setSearchSource(t.dataset.source); break;
    case 'youtube-link': openYouTubeLink(); break;
    case 'online-provider': setOnlineProvider(t.dataset.provider); break;
    case 'edit-api-key': editApiKey(); break;
    case 'edit-instance': editInstance(); break;
    case 'toggle-offline': toggleOffline(); break;
    case 'toggle-auto-offline': toggleAutoOffline(); break;
    case 'toggle-proxy': toggleProxy(); break;
    case 'online-retry': render(); break;
    case 'open-external': openExternalVideo(id); break;
    case 'open-downloads': location.hash = '#/downloads'; break;
    case 'notifications': showNotifications(); break;
    case 'sh-share': shareVideo(S.shortActive && S.shortActive.id); break;
    case 'sh-more': S.shortActive && videoMenu(S.shortActive.id); break;
    case 'install-app': doInstall(); break;
  }
});

function onTab(tab) {
  const cur = (location.hash || '#/home');
  if (tab === S.lastTab && cur.includes(tab)) {
    // повторное нажатие — прокрутка вверх + перетасовка рекомендаций
    if (tab === 'home') { S.reshuffle = true; render(); }
    $('#view').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  location.hash = '#/' + tab;
}

/* ============================== действия с видео ============================== */

async function persistVideo(v) {
  if (v.source === 'youtube') {
    S.onlineState[v.id] = { liked: v.liked || 0, saved: !!v.saved };
    await DB.kvSet('onlineState', S.onlineState);
    S.onlineSaved = [...S.onlineVideos.values()].filter((item) => item.saved);
    await DB.kvSet('onlineSaved', S.onlineSaved);
    return;
  }
  await DB.putVideo(v);
  await reloadVideos();
}

function refreshCardUI(id) {
  // мягкое обновление без перерисовки всей страницы
  const v = getVideo(id);
  if (!v) return;
  $$('[data-id="' + id + '"]').forEach((node) => {
    if (node.classList.contains('pill') || node.closest('.pill-group')) {
      if (node.dataset.act === 'like') {
        node.classList.toggle('on', v.liked === 1);
        const svg = node.querySelector('svg');
        if (svg) svg.classList.toggle('icon--fill', v.liked === 1);
        const lbl = node.querySelector('.lbl');
        if (lbl) lbl.textContent = v.likes > 0 ? fmtCount(v.likes) : 'Нравится';
      }
      if (node.dataset.act === 'dislike') {
        node.classList.toggle('on', v.liked === -1);
        const svg = node.querySelector('svg');
        if (svg) svg.classList.toggle('icon--fill', v.liked === -1);
      }
      if (node.dataset.act === 'save') {
        const lbl = node.querySelector('.lbl');
        if (lbl) lbl.textContent = v.saved ? 'Сохранено' : 'Сохранить';
        const use = node.querySelector('use');
        if (use) use.setAttribute('href', v.saved ? '#i-saved' : '#i-save');
      }
    }
  });
  // кнопка подписки на странице просмотра
  const subBtn = $('.btn-sub');
  if (subBtn && subBtn.dataset.ch === v.channelName) {
    const on = S.settings.subs[v.channelName] !== false;
    subBtn.classList.toggle('subed', on);
    subBtn.innerHTML = on ? `${icon('bell')}Вы подписаны${icon('chev-d')}` : 'Подписаться';
  }
}

async function toggleLike(id) {
  const v = getVideo(id);
  if (!v) return;
  if (v.source === 'youtube') {
    v.liked = v.liked === 1 ? 0 : 1; await persistVideo(v); refreshCardUI(id);
    toast('Отметка сохранена только на устройстве, не в YouTube.'); return;
  }
  if (v.liked === 1) { v.liked = 0; v.likes = Math.max(0, (v.likes || 1) - 1); }
  else {
    if (v.liked === -1) v.dislikes = Math.max(0, (v.dislikes || 1) - 1);
    v.liked = 1; v.likes = (v.likes || 0) + 1;
  }
  await persistVideo(v);
  refreshCardUI(id);
}

async function toggleDislike(id) {
  const v = getVideo(id);
  if (!v) return;
  if (v.source === 'youtube') {
    v.liked = v.liked === -1 ? 0 : -1; await persistVideo(v); refreshCardUI(id);
    toast('Отметка сохранена только на устройстве, не в YouTube.'); return;
  }
  if (v.liked === -1) { v.liked = 0; v.dislikes = Math.max(0, (v.dislikes || 1) - 1); }
  else {
    if (v.liked === 1) v.likes = Math.max(0, (v.likes || 1) - 1);
    v.liked = -1; v.dislikes = (v.dislikes || 0) + 1;
  }
  await persistVideo(v);
  refreshCardUI(id);
}

async function toggleSave(id) {
  const v = getVideo(id);
  if (!v) return;
  v.saved = !v.saved;
  await persistVideo(v);
  refreshCardUI(id);
  toast(v.saved ? 'Сохранено в «Смотреть позже»' : 'Удалено из «Смотреть позже»');
}

// APK: WebView не умеет скачивать blob:-ссылки через DownloadManager. Передаём
// файл нативному SAF / Android Sharesheet небольшими порциями, без доступа ко
// всему хранилищу и без гигантской строки base64 в памяти.
let pendingAndroidExport = null;

function nativeExport(v, mode) {
  if (pendingAndroidExport) { toast('Дождитесь окончания сохранения'); return; }
  pendingAndroidExport = { file: v.file, mode };
  const name = v.fileName || (v.title.replace(/[\\/:*?"<>|]/g, '_') + '.mp4');
  window.NativeApp.beginExport(mode, name, v.mime || v.file.type || 'video/mp4');
}

window.androidExportReady = async (ready) => {
  const task = pendingAndroidExport;
  if (!ready || !task) { pendingAndroidExport = null; return; }
  try {
    toast(task.mode === 'save' ? 'Сохраняем видео…' : 'Готовим видео к отправке…');
    const chunkSize = 48 * 1024;
    for (let pos = 0; pos < task.file.size; pos += chunkSize) {
      const bytes = new Uint8Array(await task.file.slice(pos, pos + chunkSize).arrayBuffer());
      const base64 = btoa(String.fromCharCode.apply(null, bytes));
      if (!window.NativeApp.appendExport(base64)) throw new Error('write failed');
      // Даем интерфейсу перерисовываться при копировании длинных видео.
      if (pos % (chunkSize * 32) === 0) await new Promise((res) => setTimeout(res, 0));
    }
    if (!window.NativeApp.finishExport()) throw new Error('finish failed');
    toast(task.mode === 'save' ? 'Видео сохранено' : 'Выберите приложение для отправки');
  } catch (err) {
    window.NativeApp.abortExport();
    toast('Не удалось сохранить видео. Проверьте свободное место.');
  } finally {
    pendingAndroidExport = null;
  }
};

async function shareVideo(id) {
  const v = getVideo(id);
  if (!v) return;
  if (v.source === 'youtube') {
    const url = 'https://www.youtube.com/' + (isShort(v) ? 'shorts/' : 'watch?v=') + v.videoId;
    if (window.NativeApp) { window.NativeApp.shareLink(url, v.title); return; }
    try {
      if (navigator.share) await navigator.share({ title: v.title, url });
      else { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); }
    } catch (_) {}
    return;
  }
  if (window.NativeApp) { nativeExport(v, 'share'); return; }
  try {
    const file = new File([v.file], (v.fileName || v.title + '.mp4'), { type: v.mime || v.file.type || 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: v.title, text: v.title });
      return;
    }
    if (navigator.share) { await navigator.share({ title: v.title, text: v.title }); return; }
    await navigator.clipboard.writeText(v.title);
    toast('Название скопировано');
  } catch (err) { /* пользователь закрыл меню */ }
}

function downloadVideo(id) {
  const v = getVideo(id);
  if (!v) return;
  if (v.source === 'youtube') { toast('Онлайн-ссылки не скачиваются. Для офлайна импортируйте свой видеофайл.'); return; }
  if (window.NativeApp) { nativeExport(v, 'save'); return; }
  const a = document.createElement('a');
  a.href = fileURL(v);
  a.download = v.fileName || (v.title.replace(/[\\/:*?"<>|]/g, '_') + '.mp4');
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Файл сохранён в «Загрузки»');
}

function videoMenu(id) {
  const v = getVideo(id);
  if (!v) return;
  if (v.source === 'youtube') {
    menuSheet(v.title, [
      { icon: 'save', label: v.saved ? 'Убрать из «Смотреть позже»' : 'Сохранить ссылку', onClick: () => toggleSave(id) },
      { icon: 'share', label: 'Поделиться ссылкой', onClick: () => shareVideo(id) },
      { icon: 'link', label: 'Открыть в YouTube', onClick: () => openExternalVideo(id) }
    ]);
    return;
  }
  const rows = [
    {
      icon: v.saved ? 'saved' : 'save',
      label: v.saved ? 'Убрать из «Смотреть позже»' : 'Сохранить в «Смотреть позже»',
      onClick: () => toggleSave(id)
    },
    { icon: 'share', label: 'Поделиться', onClick: () => shareVideo(id) },
    { icon: 'download', label: 'Скачать файл', onClick: () => downloadVideo(id) },
    { icon: 'edit', label: 'Изменить название и описание', onClick: () => editVideo(id) },
    { icon: 'shorts', label: isShort(v) ? 'Перенести в обычные видео' : 'Перенести в Shorts', onClick: () => changeVideoType(id) },
    { icon: 'trash', label: 'Удалить видео', danger: true, onClick: () => confirmDelete(id) }
  ];
  menuSheet(v.title, rows);
}

function editVideo(id) {
  const v = getVideo(id);
  if (!v) return;
  formSheet({
    title: 'Изменить видео',
    fields: [
      { name: 'title', label: 'Название', value: v.title },
      { name: 'description', label: 'Описание', value: v.description || '', multiline: true }
    ],
    onOk: async (data) => {
      const title = data.title.trim();
      if (!title) { toast('Введите название'); return; }
      v.title = title;
      v.description = data.description.trim();
      await persistVideo(v);
      toast('Изменения сохранены');
      render();
    }
  });
}

function confirmDelete(id) {
  const v = getVideo(id);
  if (!v) return;
  openSheet(`
    <div class="sheet-title">Удалить видео «${esc(v.title)}»?</div>
    <div class="sheet-form">
      <p style="font-size:13.5px;color:var(--text-2);line-height:19px">Видео будет безвозвратно удалено с этого устройства вместе с комментариями.</p>
      <div class="sheet-btns">
        <button type="button" class="sb-cancel">Отмена</button>
        <button type="button" class="sb-ok" style="background:var(--brand);color:#fff">Удалить</button>
      </div>
    </div>`);
  $('#sheet .sb-cancel').addEventListener('click', closeSheet);
  $('#sheet .sb-ok').addEventListener('click', async () => {
    closeSheet();
    await DB.delVideo(id);
    releaseVideo(id);
    await reloadVideos();
    toast('Видео удалено');
    if ((location.hash || '').includes(id)) location.hash = '#/home'; else render();
  });
}

async function toggleSub(channelName) {
  const on = S.settings.subs[channelName] !== false;
  S.settings.subs[channelName] = !on;
  await DB.kvSet('subs', S.settings.subs);
  const subBtn = $('.btn-sub');
  if (parseHash()[0] === 'shorts') {
    $$('.sh-sub[data-ch]').filter((b) => b.dataset.ch === channelName).forEach((b) => { b.textContent = !on ? 'Вы подписаны' : 'Подписаться'; });
  } else if (subBtn && $('#player') && subBtn.dataset.ch === channelName) {
    // на странице просмотра — без перезапуска плеера
    subBtn.classList.toggle('subed', !on);
    subBtn.innerHTML = !on ? `${icon('bell')}Вы подписаны${icon('chev-d')}` : 'Подписаться';
  } else {
    render();
  }
  toast(!on ? 'Вы подписаны на «' + channelName + '»' : 'Подписка отменена');
}

/* ============================== комментарии ============================== */

async function sendComment() {
  const inp = $('#cm-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  const videoId = inp.dataset.video;
  const c = await DB.addComment(videoId, text, S.settings.channelName);
  inp.value = '';

  // добавляем в DOM без перезапуска плеера
  const blk = $('#full-comments');
  if (blk) {
    blk.hidden = false;
    const node = document.createElement('div');
    node.className = 'cm-item';
    node.innerHTML = `
      ${avatarHTML(c.author, '', S.settings.channelColor)}
      <div class="cm-body">
        <div class="cm-author"><b>${esc(c.author)}</b> • ${timeAgo(c.at)}</div>
        <div class="cm-text">${esc(c.text)}</div>
        <div class="cm-actions">
          <button data-act="del-comment" data-id="${c.id}">Удалить</button>
        </div>
      </div>`;
    const listHost = $('#cm-list') || blk;
    listHost.appendChild(node);
  }
  updateCommentsCount();
}

async function delComment(cid) {
  await DB.delComment(cid);
  const btn = document.querySelector(`[data-act="del-comment"][data-id="${cid}"]`);
  const item = btn && btn.closest('.cm-item');
  if (item) item.remove();
  updateCommentsCount();
}

function updateCommentsCount() {
  const inp = $('#cm-input');
  const head = $('.cm-head span');
  if (inp && head) {
    DB.listComments(inp.dataset.video).then((cs) => { head.textContent = String(cs.length); });
  }
}

/* ============================== настройки ============================== */

async function setTheme(t) {
  S.settings.theme = t;
  await DB.kvSet('theme', t);
  const scroll = $('#view').scrollTop;
  applyTheme();
  render();
  $('#view').scrollTop = scroll;
}

async function toggleAutoplay() {
  S.settings.autoplayNext = !S.settings.autoplayNext;
  await DB.kvSet('autoplayNext', S.settings.autoplayNext);
  const scroll = $('#view').scrollTop; render(); $('#view').scrollTop = scroll;
}

function editChannel() {
  formSheet({
    title: 'Ваш канал',
    fields: [{ name: 'name', label: 'Название канала', value: S.settings.channelName, placeholder: 'Мой канал' }],
    okLabel: 'Сохранить',
    onOk: async (data) => {
      const name = data.name.trim() || 'Мой канал';
      const old = S.settings.channelName;
      S.settings.channelName = name;
      await DB.kvSet('channelName', name);
      // переименовываем канал у локальных видео
      for (const v of S.videos.filter((x) => x.channelName === old)) {
        v.channelName = name;
        await DB.putVideo(v);
      }
      await reloadVideos();
      applyTheme();
      render();
    }
  });
}

function confirmClearHistory() {
  openSheet(`
    <div class="sheet-title">Очистить историю просмотров?</div>
    <div class="sheet-form">
      <div class="sheet-btns">
        <button type="button" class="sb-cancel">Отмена</button>
        <button type="button" class="sb-ok" style="background:var(--brand);color:#fff">Очистить</button>
      </div>
    </div>`);
  $('#sheet .sb-cancel').addEventListener('click', closeSheet);
  $('#sheet .sb-ok').addEventListener('click', async () => {
    closeSheet();
    await DB.clearHistory();
    toast('История очищена');
    render();
  });
}

function confirmWipe() {
  openSheet(`
    <div class="sheet-title">Удалить все данные?</div>
    <div class="sheet-form">
      <p style="font-size:13.5px;color:var(--text-2);line-height:19px">Все видео, комментарии и история будут безвозвратно удалены с устройства.</p>
      <div class="sheet-btns">
        <button type="button" class="sb-cancel">Отмена</button>
        <button type="button" class="sb-ok" style="background:var(--brand);color:#fff">Удалить всё</button>
      </div>
    </div>`);
  $('#sheet .sb-cancel').addEventListener('click', closeSheet);
  $('#sheet .sb-ok').addEventListener('click', async () => {
    closeSheet();
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    videoUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls.clear(); videoUrls.clear();
    await DB.wipeAll();
    S.onlineVideos.clear(); S.onlineState = {}; S.onlineSaved = [];
    Object.assign(S.settings, { offlineMode: false, autoOffline: true, homeSource: 'local', onlineProvider: 'official', youtubeApiKey: '', invidiousInstance: '', proxyPlayback: true });
    try { localStorage.removeItem('offlineMode'); localStorage.removeItem('autoOffline'); } catch (_) {}
    syncNetworkSettings();
    await reloadVideos();
    toast('Все данные удалены');
    location.hash = '#/home';
    render();
  });
}

/* ============================== страницы ============================== */

const CHIPS = [
  { id: 'all', label: 'Все' },
  { id: 'new', label: 'Недавно добавленные' },
  { id: 'pop', label: 'Популярные' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'long', label: 'Длинные видео' }
];

async function viewHome(view) {
  if (S.settings.homeSource === 'youtube' && !effectiveOffline()) return viewOnlineHome(view);
  let list = S.videos.filter((v) => !isShort(v));
  const shorts = shuffle(S.videos.filter(isShort));
  switch (S.filter) {
    case 'new': list.sort((a, b) => b.createdAt - a.createdAt); break;
    case 'pop': list.sort((a, b) => (b.views || 0) - (a.views || 0)); break;
    case 'long': list = shuffle(list.filter((v) => (v.duration || 0) >= 240)); break;
    default: list = shuffle(list);
  }
  const chips = CHIPS.map((c) => `<button class="chip ${S.filter === c.id ? 'on' : ''}" data-act="chip" data-chip="${c.id}">${c.label}</button>`).join('');
  let feed;
  if (!S.videos.length) {
    feed = emptyHTML('myvids', effectiveOffline() ? 'Нет видео для офлайн-просмотра' : 'Ваша лента начинается здесь',
      'Добавьте свои видео и Shorts с устройства. Или выберите YouTube выше для онлайн-просмотра.',
      `<button class="btn-blue" data-act="upload">${icon('plus')}Добавить видео</button>`);
  } else if (S.filter === 'shorts') {
    feed = shorts.length ? shortsGridHTML(shorts) : emptyHTML('shorts', 'Пока нет Shorts', 'Добавьте несколько коротких роликов через + → Добавить Shorts.');
  } else if (S.filter === 'all' && shorts.length) {
    feed = (list[0] ? feedHTML([list[0]]) : '') + shortsShelfHTML(shorts) + feedHTML(list.slice(1));
  } else feed = list.length ? feedHTML(list) : emptyHTML('myvids', 'Нет видео в этом разделе', 'Shorts находятся в своей отдельной ленте.');
  view.innerHTML = sourceStripHTML() + `<div class="chips">${chips}</div>` + feed;
}

async function viewOnlineHome(view) {
  const ticket = renderGeneration;
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  view.innerHTML = sourceStripHTML('youtube') + skeletonHTML();
  if (!YouTube.configured()) {
    view.innerHTML = sourceStripHTML('youtube') + emptyHTML('globe', 'Подключите YouTube',
      'Видео по ссылке открываются без ключа. Для поиска и ленты укажите свой API-ключ или HTTPS-сервер Invidious.',
      `<button class="btn-blue" data-act="youtube-link">Открыть ссылку</button><button class="text-btn" data-act="open-settings">Настройки подключения</button>`);
    return;
  }
  try {
    const list = rememberOnline(await YouTube.trending(controller.signal));
    if (ticket !== renderGeneration || effectiveOffline()) return;
    const shorts = list.filter(isShort), regular = list.filter((v) => !isShort(v));
    view.innerHTML = sourceStripHTML('youtube') + '<div class="chips"><span class="chip on">Популярное на YouTube</span><button class="chip" data-act="open-search">Поиск</button><button class="chip" data-act="online-retry">Обновить</button></div>'
      + feedHTML(regular.slice(0, 2)) + (shorts.length ? shortsShelfHTML(shorts) : '') + feedHTML(regular.slice(2));
    if (!list.length) view.innerHTML += emptyHTML('myvids', 'Сервер вернул пустую ленту', 'Попробуйте поиск или другой источник.');
  } catch (error) {
    if (ticket !== renderGeneration || error.name === 'AbortError') return;
    view.innerHTML = sourceStripHTML('youtube') + networkErrorHTML(error);
  }
}

async function viewSubs(view) {
  const videos = S.videos.filter((v) => S.settings.subs[v.channelName] !== false).sort((a, b) => b.createdAt - a.createdAt);
  if (!videos.length) {
    view.innerHTML = emptyHTML('subs', 'Не пропустите новые видео',
      'Здесь собраны ролики локальных каналов, на которые вы подписаны. Подписки Google не синхронизируются.',
      `<button class="btn-blue" data-act="upload">Добавить видео</button>`);
    return;
  }
  const channels = [...new Set(videos.map((v) => v.channelName))];
  const shorts = videos.filter(isShort), regular = videos.filter((v) => !isShort(v));
  view.innerHTML = `<div class="subscription-channels">${channels.map((name) => `<button data-act="open-channel" data-ch="${esc(name)}">${avatarHTML(name)}<span>${esc(name)}</span></button>`).join('')}</div>
    <div class="section-head">Последние видео</div>` + feedHTML(regular.slice(0, 2))
    + (shorts.length ? shortsShelfHTML(shorts) : '') + feedHTML(regular.slice(2));
}

async function viewYou(view) {
  const ticket = renderGeneration;
  const name = S.settings.channelName, history = await DB.listHistory();
  if (ticket !== renderGeneration) return;
  const recent = [];
  for (const entry of history) {
    const video = getVideo(entry.videoId);
    if (video && !recent.some((item) => item.id === video.id)) recent.push(video);
    if (recent.length === 8) break;
  }
  const saved = S.videos.filter((video) => video.saved).length + S.onlineSaved.length;
  view.innerHTML = `<div class="you-profile"><button class="you-head" data-act="open-channel" data-ch="${esc(name)}">
    ${avatarHTML(name, '', S.settings.channelColor)}<div class="tb-grow"><h1>${esc(name)}</h1><p>@${esc(name.replace(/\s/g, ''))} · Посмотреть канал ${icon('chev-r')}</p></div></button>
    <div class="you-quick"><button class="pill" data-act="open-channel" data-ch="${esc(name)}">${icon('myvids')}Ваш канал</button><button class="pill" data-act="open-settings">${icon('gear')}Настройки</button></div>
  </div>
  <div class="library-head"><h2>История</h2><button class="outlined-btn" data-act="open-history">Показать всё</button></div>
  ${recent.length ? `<div class="hscroll">${recent.map((video) => `<button class="hcard" data-act="watch" data-id="${esc(video.id)}"><div class="hthumb"><img src="${esc(thumbURL(video) || placeholderThumb)}" alt="" loading="lazy">${isShort(video) ? icon('shorts', 'hshort-badge icon--fill') : ''}</div><div class="htitle">${esc(video.title)}</div><div class="hsub">${esc(video.channelName)}</div></button>`).join('')}</div>` : '<p class="settings-note">Посмотренные ролики появятся здесь.</p>'}
  <div class="library-head"><h2>Плейлисты</h2></div>
  <button class="list-row" data-act="open-watch-later">${icon('clock')}<span class="lr-label">Смотреть позже</span><span class="lr-value">${saved}</span>${icon('chev-r', 'lr-chev')}</button>
  <div class="list-sep"></div>
  <button class="list-row" data-act="open-my-videos">${icon('myvids')}<span class="lr-label">Ваши видео</span><span class="lr-value">${S.videos.length}</span>${icon('chev-r', 'lr-chev')}</button>
  <button class="list-row" data-act="open-downloads">${icon('download')}<span class="lr-label">Видео на устройстве</span><span class="lr-value">${S.videos.length}</span>${icon('chev-r', 'lr-chev')}</button>
  <button class="list-row" data-act="open-settings">${icon('gear')}<span class="lr-label">Настройки</span>${icon('chev-r', 'lr-chev')}</button>
  <div id="install-host">${installPrompt ? installBtnHTML() : ''}</div>
  <div class="about-note">${icon('shield')}<div>Ваши файлы остаются на устройстве. В режиме YouTube подключение идёт к выбранному онлайн-источнику.</div></div>`;
}

async function viewWatch(view, id) {
  if (id.startsWith('yt:')) return viewOnlineWatch(view, id.slice(3));
  const ticket = renderGeneration;
  const v = getVideo(id);
  if (v && isShort(v)) { S.shortStart = id; location.hash = '#/shorts'; return; }
  if (!v) {
    view.innerHTML = emptyHTML('info', 'Видео не найдено', 'Возможно, оно было удалено.');
    return;
  }

  // засчитываем просмотр один раз за визит
  if (S._watchVisit !== id) {
    S._watchVisit = id;
    v.views = (v.views || 0) + 1;
    DB.putVideo(v);
    DB.addHistory(v.id);
  }

  const comments = await DB.listComments(v.id);
  if (ticket !== renderGeneration) return;
  const recs = shuffle(S.videos.filter((x) => x.id !== v.id && !isShort(x)));
  const subOn = S.settings.subs[v.channelName] !== false;
  const chCount = S.videos.filter((x) => x.channelName === v.channelName).length;

  view.innerHTML = `
  <div class="watch">
    <div class="player-zone">
      <div class="ambient" style="background-image:url(${thumbURL(v)})"></div>
      <div class="player" id="player">
        <video id="wvideo" playsinline preload="metadata"></video>
        <div class="pl-tap">
          <div class="pl-zone left"></div>
          <div class="pl-zone center"></div>
          <div class="pl-zone right"></div>
        </div>
        <div class="pl-ctl" id="plctl">
          <div class="pl-seek-flash left" id="flash-l">${icon('replay')}<span>10 сек</span></div>
          <div class="pl-seek-flash right" id="flash-r">${icon('replay')}<span>10 сек</span></div>
          <div class="pl-center-btn" id="pl-center">${icon('play', 'icon--fill')}</div>
          <div class="pl-bottom">
            <div class="pl-bar-wrap" id="pl-bar-wrap">
              <div class="pl-bar">
                <div class="buf" id="pl-buf"></div>
                <div class="played" id="pl-played"></div>
                <div class="knob" id="pl-knob"></div>
              </div>
            </div>
            <div class="pl-row">
              <div class="pl-time" id="pl-time">0:00 / ${fmtDur(v.duration)}</div>
              <button class="pl-btn" id="pl-speed" aria-label="Скорость">${icon('gear')}</button>
              <button class="pl-btn" id="pl-fs" aria-label="На весь экран">${icon('fs')}</button>
            </div>
          </div>
        </div>
        <div class="pl-anim" id="pl-anim">${icon('play', 'icon--fill')}</div>
        <button class="pl-back" id="pl-back" aria-label="Назад">${icon('back')}</button>
      </div>
    </div>

    <h1 class="w-title">${esc(v.title)}</h1>
    <div class="w-meta">
      <span>${fmtViews(v.views)} • ${timeAgo(v.createdAt)}</span><span class="more-link" data-act="desc-toggle">…ещё</span>
    </div>

    <div class="w-channel">
      ${avatarHTML(v.channelName, '', S.settings.channelColor)}
      <div class="ch-text" data-act="open-channel" data-ch="${esc(v.channelName)}">
        <div class="ch-name">${esc(v.channelName)}</div>
        <div class="ch-subs">${fmtSubs(1)}</div>
      </div>
      <button class="btn-sub ${subOn ? 'subed' : ''}" data-act="sub" data-ch="${esc(v.channelName)}">
        ${subOn ? `${icon('bell')}Вы подписаны${icon('chev-d')}` : 'Подписаться'}
      </button>
    </div>


    <div class="w-actions">
      <div class="pill-group">
        <button data-act="like" data-id="${v.id}" class="${v.liked === 1 ? 'on' : ''}">
          ${icon('like', v.liked === 1 ? 'icon--fill' : '')}<span class="lbl">${v.likes > 0 ? fmtCount(v.likes) : 'Нравится'}</span>
        </button>
        <div class="divider"></div>
        <button data-act="dislike" data-id="${v.id}" class="${v.liked === -1 ? 'on' : ''}">
          ${icon('dislike', v.liked === -1 ? 'icon--fill' : '')}
        </button>
      </div>
      <button class="pill" data-act="share" data-id="${v.id}">${icon('share')}Поделиться</button>
      <button class="pill" data-act="download" data-id="${v.id}">${icon('download')}Скачать</button>
      <button class="pill" data-act="save" data-id="${v.id}">
        ${icon(v.saved ? 'saved' : 'save')}<span class="lbl">${v.saved ? 'Сохранено' : 'Сохранить'}</span>
      </button>
      <button class="pill" data-act="card-menu" data-id="${v.id}">${icon('more-h')}</button>
    </div>


    <div class="w-desc" data-act="desc-toggle">
      <div class="d-head">${fmtViews(v.views)} • ${timeAgo(v.createdAt)}</div>
      <div class="d-body clamp">${esc(v.description || 'Без описания')}</div>
    </div>

    <div class="w-comments" data-act="comments-toggle">
      <div class="cm-head">Комментарии <span>${comments.length}</span></div>
      ${comments.length ? `
        <div class="cm-preview">
          ${avatarHTML(comments[0].author, '', S.settings.channelColor)}
          <p>${esc(comments[0].text)}</p>
        </div>` : `
        <div class="cm-preview"><p style="color:var(--text-2)">Добавьте первый комментарий</p></div>`}
    </div>

    <div class="comments-block" id="full-comments" hidden>
      <div class="cm-input-row">
        ${avatarHTML(S.settings.channelName, '', S.settings.channelColor)}
        <input id="cm-input" data-video="${v.id}" placeholder="Введите комментарий..." autocomplete="off">
        <button class="icon-btn" data-act="send-comment" aria-label="Отправить">${icon('check')}</button>
      </div>
      <div id="cm-list">
      ${comments.map((c) => `
        <div class="cm-item">
          ${avatarHTML(c.author, '', S.settings.channelColor)}
          <div class="cm-body">
            <div class="cm-author"><b>${esc(c.author)}</b> • ${timeAgo(c.at)}</div>
            <div class="cm-text">${esc(c.text)}</div>
            <div class="cm-actions">
              <button data-act="del-comment" data-id="${c.id}">Удалить</button>
            </div>
          </div>
        </div>`).join('')}
      </div>
    </div>

    <div class="w-upnext">
      <div class="section-head">Рекомендации</div>
      ${recs.length ? recs.map(videoCardHTML).join('') : `<p style="padding:12px;color:var(--text-2);font-size:13.5px">Загрузите ещё видео — они появятся здесь в случайном порядке.</p>`}
    </div>
  </div>`;

  setupPlayer(v, recs);

  const cmInp = $('#cm-input');
  if (cmInp) cmInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });
}

/* ============================== онлайн-просмотр ============================== */

async function setSource(source) {
  if (source === 'youtube' && effectiveOffline()) { toast('Сначала отключите офлайн-режим и подключитесь к сети.'); return; }
  S.settings.homeSource = source === 'youtube' ? 'youtube' : 'local';
  S.searchSource = S.settings.homeSource;
  await DB.kvSet('homeSource', S.settings.homeSource);
  if (parseHash()[0] !== 'home') location.hash = '#/home'; else render();
}

function setSearchSource(source) {
  if (source === 'youtube' && effectiveOffline()) { toast('Онлайн-поиск недоступен в офлайн-режиме.'); return; }
  S.searchSource = source === 'youtube' ? 'youtube' : 'local';
  S.searchQuery = $('#search-input')?.value || '';
  render();
}

function openCreateMenu() {
  menuSheet('Создать', [
    { icon: 'myvids', label: 'Добавить видео', onClick: () => openUpload('video') },
    { icon: 'shorts', iconFill: true, label: 'Добавить Shorts', onClick: () => openUpload('short') },
    { icon: 'link', label: 'Открыть ссылку YouTube', onClick: openYouTubeLink }
  ]);
}

function openYouTubeLink() {
  if (effectiveOffline()) { toast('Ссылки YouTube требуют подключения. Ваши файлы доступны без сети.'); return; }
  formSheet({ title: 'Открыть видео YouTube', fields: [
    { name: 'url', label: 'Ссылка на видео или Shorts', placeholder: 'https://www.youtube.com/watch?v=…' }
  ], okLabel: 'Открыть', onOk: ({ url }) => {
    const parsed = Media.parseYouTubeLink(url);
    if (!parsed) { toast('Нужна ссылка на конкретное видео YouTube или Shorts.'); return; }
    if (parsed.short) location.hash = '#/online-short/' + parsed.videoId;
    else location.hash = '#/watch/yt:' + parsed.videoId;
  } });
}

function openExternalVideo(id) {
  const video = getVideo(id);
  if (!video?.videoId) return;
  const url = 'https://www.youtube.com/watch?v=' + video.videoId;
  if (window.NativeApp) window.NativeApp.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function showNotifications() {
  openSheet(`<div class="sheet-title">Уведомления</div><div class="about-note">Уведомлений пока нет. Это самостоятельный клиент: уведомления и аккаунт Google не синхронизируются.</div>`);
}

async function changeVideoType(id) {
  const video = getVideo(id);
  if (!video || video.source === 'youtube') return;
  if (!isShort(video) && video.duration > Media.SHORT_MAX_SECONDS) {
    toast('Shorts — до 3 минут. Этот ролик длиннее.'); return;
  }
  video.contentType = isShort(video) ? 'video' : 'short';
  await persistVideo(video);
  toast(video.contentType === 'short' ? 'Перенесено в Shorts' : 'Перенесено в обычные видео');
  if (parseHash()[0] === 'watch' && isShort(video)) { S.shortStart = id; location.hash = '#/shorts'; }
  else render();
}

async function viewOnlineWatch(view, videoId, short = false) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) {
    view.innerHTML = emptyHTML('info', 'Некорректная ссылка YouTube', 'Откройте ссылку на конкретное видео или Shorts через кнопку +.');
    return;
  }
  const ticket = renderGeneration;
  if (effectiveOffline()) {
    view.innerHTML = emptyHTML('wifi-off', 'Это онлайн-видео', 'Ссылка не содержит видеофайл. Без интернета можно смотреть только импортированные файлы.',
      `<button class="btn-blue" data-act="open-downloads">Видео на устройстве</button><button class="text-btn" data-act="open-settings">Настройки</button>`);
    return;
  }
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  view.innerHTML = `<div class="online-loading">${icon('refresh')}Подключаемся к YouTube…</div>`;
  let result, metaError = '';
  try { result = await YouTube.video(videoId, controller.signal, short); }
  catch (error) {
    if (error.name === 'AbortError' || ticket !== renderGeneration) return;
    if (S.settings.onlineProvider === 'invidious') { view.innerHTML = networkErrorHTML(error); return; }
    // Ошибка oEmbed не означает ошибку плеера: он может открыть ссылку самостоятельно.
    metaError = error.message;
    result = { item: getVideo('yt:' + videoId) || { id: 'yt:' + videoId, videoId, source: 'youtube',
      title: 'Видео YouTube', channelName: 'YouTube', contentType: short ? 'short' : 'video' }, stream: '', recommendations: [] };
  }
  if (ticket !== renderGeneration || effectiveOffline()) return;
  const video = rememberOnline([result.item])[0];
  short = short || isShort(video);
  const recs = rememberOnline(result.recommendations).filter((v) => v.id !== video.id && !isShort(v));
  DB.addHistory(video.id).catch(() => {});
  // Метаданные истории, а не видеопотоки. Онлайн-видео НЕ выдаются за скачанные.
  DB.kvSet('onlineHistoryMeta', [...S.onlineVideos.values()].slice(-100)).catch(() => {});
  view.innerHTML = `<div class="watch online-watch ${short ? 'online-short-watch' : ''}">
    <div class="online-player-zone"><button class="online-back icon-btn" data-act="back" aria-label="Назад">${icon('back')}</button>
      <div id="online-player" class="online-player ${short ? 'vertical' : ''}"></div>
    </div>
    <h1 class="w-title">${esc(video.title)}</h1>
    <div class="w-meta">${esc(videoStats(video) || 'Онлайн-видео YouTube')}</div>
    <div class="w-channel">${videoAvatar(video)}<div class="ch-text"><div class="ch-name">${esc(video.channelName)}</div>
      <div class="ch-subs">${S.settings.onlineProvider === 'invidious' ? 'Через выбранный сервер' : 'Официальный плеер YouTube'}</div></div>
      <button class="btn-sub" data-act="open-external" data-id="${esc(video.id)}">В YouTube</button>
    </div>
    <div class="w-actions">
      <div class="pill-group"><button data-act="like" data-id="${esc(video.id)}" class="${video.liked === 1 ? 'on' : ''}">${icon('like', video.liked === 1 ? 'icon--fill' : '')}<span class="lbl">${video.likes ? fmtCount(video.likes) : 'Нравится'}</span></button><div class="divider"></div>
        <button data-act="dislike" data-id="${esc(video.id)}" class="${video.liked === -1 ? 'on' : ''}" aria-label="Не нравится">${icon('dislike', video.liked === -1 ? 'icon--fill' : '')}</button></div>
      <button class="pill" data-act="share" data-id="${esc(video.id)}">${icon('share')}Поделиться</button>
      <button class="pill" data-act="save" data-id="${esc(video.id)}">${icon(video.saved ? 'saved' : 'save')}<span class="lbl">${video.saved ? 'Сохранено' : 'Сохранить'}</span></button>
      <button class="pill" data-act="open-external" data-id="${esc(video.id)}">${icon('link')}В YouTube</button>
    </div>
    <div class="online-status" id="online-status" role="status">${esc(metaError || 'Онлайн-просмотр. Видеофайл не сохраняется на устройстве.')}</div>
    ${video.description ? `<div class="w-desc" data-act="desc-toggle"><div class="d-body clamp">${esc(video.description)}</div></div>` : ''}
    <div class="w-comments" id="online-comments"><div class="cm-head">Комментарии на устройстве ${icon('chev-d')}</div><div class="cm-preview"><p>Не публикуются в YouTube</p></div></div>
    ${recs.length ? `<div class="section-head">Далее</div>` + feedHTML(recs) : ''}
    <p class="online-disclaimer">Самостоятельный клиент, не приложение Google. Лайки и сохранённые ссылки — локальные. При блокировке источника настройте доступную сеть или свой HTTPS-сервер.</p>
  </div>`;
  $('#online-comments').addEventListener('click', () => openShortsComments(video.id));
  const host = $('#online-player');
  const status = $('#online-status');
  if (result.stream) {
    const player = document.createElement('video');
    player.controls = true; player.playsInline = true; player.preload = 'metadata'; player.src = result.stream;
    player.poster = thumbURL(video);
    host.appendChild(player);
    player.addEventListener('error', () => { status.textContent = 'Не удалось загрузить поток. Проверьте выбранный сервер или откройте видео в YouTube.'; });
    player.play().catch(() => {});
    cleanups.push(() => { player.pause(); player.removeAttribute('src'); player.load(); });
  } else {
    const frame = document.createElement('iframe');
    frame.title = video.title; frame.src = YouTube.embedURL(videoId);
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    host.appendChild(frame);
    const targetOrigin = new URL(frame.src).origin;
    let ready = false;
    const send = (message) => frame.contentWindow?.postMessage(JSON.stringify(message), targetOrigin);
    const handshake = setInterval(() => { if (!ready) send({ event: 'listening', id: videoId }); }, 1000);
    const timeout = setTimeout(() => {
      if (!ready) status.textContent = 'Если плеер не загрузился, проверьте сеть, источник и доступность YouTube. Можно открыть видео внешней кнопкой.';
      clearInterval(handshake);
    }, 12000);
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== targetOrigin) return;
      let data; try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (_) { return; }
      if (data?.event === 'onReady' || data?.event === 'initialDelivery') {
        ready = true; clearInterval(handshake); clearTimeout(timeout);
        status.textContent = 'Онлайн-просмотр. Видеофайл не сохраняется на устройстве.';
        send({ event: 'command', func: 'addEventListener', args: ['onError'] });
      }
      if (data?.event === 'onError') {
        const code = data.info;
        status.textContent = code === 101 || code === 150 ? 'Автор запретил встроенный просмотр. Откройте видео в YouTube.'
          : code === 153 ? 'YouTube отклонил идентификацию встроенного плеера. Откройте видео в браузере.'
          : 'YouTube не смог воспроизвести видео (код ' + code + '). Проверьте доступность и сеть.';
      }
    };
    const pauseOnline = () => send({ event: 'command', func: 'pauseVideo', args: [] });
    window.pauseOnlinePlayer = pauseOnline;
    const onVisibility = () => { if (document.hidden) pauseOnline(); };
    window.addEventListener('message', onMessage); document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => { clearInterval(handshake); clearTimeout(timeout); window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisibility); window.pauseOnlinePlayer = null; frame.remove(); });
  }
}

/* ============================== плеер ============================== */

function setupPlayer(v, recs) {
  const wrap = $('#player');
  const video = $('#wvideo');
  const ctl = $('#plctl');
  const center = $('#pl-center');
  const timeEl = $('#pl-time');
  const played = $('#pl-played');
  const buf = $('#pl-buf');
  const knob = $('#pl-knob');
  const barWrap = $('#pl-bar-wrap');
  const anim = $('#pl-anim');
  const flashL = $('#flash-l');
  const flashR = $('#flash-r');

  video.src = fileURL(v);
  video.poster = thumbURL(v);

  let hideTimer = null;
  let dragging = false;

  function showControls(sticky) {
    ctl.classList.remove('hidden');
    center.classList.toggle('show', video.paused);
    clearTimeout(hideTimer);
    if (!sticky && !video.paused) {
      hideTimer = setTimeout(() => {
        ctl.classList.add('hidden');
        center.classList.remove('show');
      }, 2800);
    }
  }

  function flashIcon() {
    anim.classList.remove('show');
    void anim.offsetWidth;
    anim.querySelector('use').setAttribute('href', video.paused ? '#i-pause' : '#i-play');
    anim.classList.add('show');
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    flashIcon();
    showControls(video.paused);
  }

  function seekBy(d) {
    video.currentTime = Math.min(Math.max(0, video.currentTime + d), video.duration || 0);
    const f = d < 0 ? flashL : flashR;
    f.classList.add('show');
    setTimeout(() => f.classList.remove('show'), 450);
    showControls();
  }

  // --- тапы: один — управление, двойной по краям — перемотка ---
  let lastTap = 0, tapTimer = null;
  $$('.pl-zone', wrap).forEach((zone, idx) => {
    zone.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (idx === 0) seekBy(-10);
        else if (idx === 2) seekBy(10);
        else togglePlay();
        return;
      }
      lastTap = now;
      tapTimer = setTimeout(() => {
        if (ctl.classList.contains('hidden')) showControls(video.paused);
        else { ctl.classList.add('hidden'); center.classList.remove('show'); }
      }, 280);
    });
  });

  center.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  $('#pl-back').addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    else if (history.length > 1) history.back(); else location.hash = '#/home';
  });

  video.addEventListener('play', () => showControls());
  video.addEventListener('pause', () => showControls(true));
  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const p = (video.currentTime / video.duration) * 100;
    played.style.width = p + '%';
    knob.style.left = p + '%';
    timeEl.textContent = `${fmtDur(video.currentTime)} / ${fmtDur(video.duration)}`;
  });
  video.addEventListener('progress', () => {
    try {
      if (video.buffered.length && video.duration) {
        buf.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100 + '%';
      }
    } catch (_) {}
  });
  video.addEventListener('ended', () => onEnded());

  // --- перемотка перетаскиванием ---
  function seekFromX(clientX) {
    const rect = barWrap.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = p * video.duration;
    played.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
  }
  barWrap.addEventListener('pointerdown', (e) => {
    dragging = true;
    barWrap.classList.add('drag');
    barWrap.setPointerCapture(e.pointerId);
    seekFromX(e.clientX);
  });
  barWrap.addEventListener('pointermove', (e) => { if (dragging) seekFromX(e.clientX); });
  barWrap.addEventListener('pointerup', (e) => {
    dragging = false;
    barWrap.classList.remove('drag');
    showControls();
    e.stopPropagation();
  });

  // --- скорость ---
  $('#pl-speed').addEventListener('click', (e) => {
    e.stopPropagation();
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    menuSheet('Скорость воспроизведения', speeds.map((sp) => ({
      label: sp === 1 ? 'Обычная' : sp.toString().replace('.', ',') + '×',
      checked: Math.abs(video.playbackRate - sp) < 0.01,
      onClick: () => { video.playbackRate = sp; showControls(); }
    })));
  });

  // --- полный экран ---
  $('#pl-fs').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await wrap.requestFullscreen();
        try { await screen.orientation.lock('landscape'); } catch (_) {}
      }
    } catch (_) {}
  });
  document.addEventListener('fullscreenchange', onFsChange);
  function onFsChange() {
    const fsOn = !!document.fullscreenElement;
    wrap.classList.toggle('fs', fsOn);
    $('#pl-fs use').setAttribute('href', fsOn ? '#i-fs-exit' : '#i-fs');
    showControls();
    if (!fsOn) { try { screen.orientation.unlock(); } catch (_) {} }
  }

  // --- автовоспроизведение следующего ---
  let nextTimer = null;
  function onEnded() {
    showControls(true);
    const next = recs[0];
    if (!next || !S.settings.autoplayNext) return;
    const overlay = document.createElement('div');
    overlay.className = 'pl-next';
    overlay.innerHTML = `
      <div class="pn-label">Далее</div>
      <div class="pn-title">${esc(next.title)}</div>
      <div class="pn-count">5</div>
      <button class="pn-cancel">Отмена</button>`;
    wrap.appendChild(overlay);
    let n = 5;
    nextTimer = setInterval(() => {
      n -= 1;
      const c = overlay.querySelector('.pn-count');
      if (c) c.textContent = String(n);
      if (n <= 0) {
        clearInterval(nextTimer);
        location.hash = '#/watch/' + next.id;
      }
    }, 1000);
    overlay.querySelector('.pn-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      clearInterval(nextTimer);
      overlay.remove();
    });
  }

  // попытка автозапуска (может быть заблокирована браузером — это нормально)
  video.play().catch(() => showControls(true));
  showControls();

  cleanups.push(() => {
    clearTimeout(hideTimer);
    clearInterval(nextTimer);
    document.removeEventListener('fullscreenchange', onFsChange);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
}

/* ============================== Shorts ============================== */

async function viewShorts(view) {
  let items = S.videos.filter(isShort);
  if (!items.length) {
    view.innerHTML = emptyHTML('shorts', 'Найдите свой следующий Short',
      'Добавляйте несколько роликов сразу — количество не ограничено. Shorts не попадают в обычные видео.',
      `<button class="btn-blue" data-act="upload-video" data-type="short">${icon('plus')}Добавить Shorts</button>`);
    return;
  }
  if (S.shortStart) {
    const index = items.findIndex((item) => item.id === S.shortStart);
    if (index > 0) items = [...items.slice(index), ...items.slice(0, index)];
    S.shortStart = null;
  }
  S.shortActive = null;
  view.innerHTML = `<div class="shorts-page">
    <div class="shorts-top"><h1>Shorts</h1>
      <button class="icon-btn" id="sh-sound" aria-label="Выключить звук">${icon('volume')}</button>
      <button class="icon-btn" data-act="upload-video" data-type="short" aria-label="Добавить Shorts">${icon('plus')}</button>
      <button class="icon-btn" data-act="open-search" aria-label="Поиск">${icon('search')}</button>
    </div>
    <div class="shorts-feed" id="shorts-feed" aria-label="Лента Shorts">
      ${items.map((video) => `<article class="short" data-id="${video.id}">
        <video playsinline loop preload="none" poster="${esc(thumbURL(video))}" aria-label="${esc(video.title)}"></video>
        <div class="sh-gradient"></div><div class="sh-pause">${icon('play', 'icon--fill')}</div>
        <div class="sh-info"><div class="sh-ch">${videoAvatar(video)}<span>@${esc(video.channelName.replace(/\s/g, ''))}</span>
          <button class="sh-sub" data-act="sub" data-ch="${esc(video.channelName)}">${S.settings.subs[video.channelName] !== false ? 'Вы подписаны' : 'Подписаться'}</button>
        </div><div class="sh-title">${esc(video.title)}</div><div class="sh-audio">${icon('music')}Оригинальный звук</div></div>
        <div class="sh-rail">
          <button data-act="sh-like" class="${video.liked === 1 ? 'on' : ''}" aria-label="Нравится">${icon('like', video.liked === 1 ? 'icon--fill' : '')}<span class="cnt">${video.likes ? fmtCount(video.likes) : 'Нравится'}</span></button>
          <button data-act="sh-dislike" class="${video.liked === -1 ? 'on' : ''}" aria-label="Не нравится">${icon('dislike', video.liked === -1 ? 'icon--fill' : '')}<span>Не нравится</span></button>
          <button data-act="sh-comments" aria-label="Комментарии">${icon('comment', 'icon--fill')}<span class="sh-comment-count">0</span></button>
          <button data-act="sh-share" aria-label="Поделиться">${icon('share', 'icon--fill')}<span>Поделиться</span></button>
          <button data-act="sh-more" aria-label="Ещё">${icon('more-v', 'icon--fill')}</button>
        </div><div class="sh-progress"><i></i></div>
      </article>`).join('')}
    </div>
    <div class="sh-navigation"><button id="sh-prev" class="icon-btn" aria-label="Предыдущий Short">${icon('chev-u')}</button><button id="sh-next" class="icon-btn" aria-label="Следующий Short">${icon('chev-d')}</button></div>
  </div>`;
  const feed = $('#shorts-feed');
  const nodes = $$('.short', feed);
  const viewed = new Set();
  let activeNode = null, muted = false;
  function activate(node) {
    if (!node || node === activeNode) return;
    activeNode = node;
    const index = nodes.indexOf(node);
    S.shortActive = getVideo(node.dataset.id);
    nodes.forEach((other, i) => {
      const player = $('video', other);
      if (Math.abs(i - index) <= 1 && !player.getAttribute('src')) {
        player.src = fileURL(getVideo(other.dataset.id));
        player.preload = other === node ? 'auto' : 'metadata';
      }
      if (other === node) {
        player.muted = muted;
        player.play().then(() => { if (other === activeNode) $('.sh-pause', other).classList.remove('show'); }).catch(() => {
          if (other !== activeNode || !other.isConnected) return;
          player.muted = true;
          player.play().catch(() => $('.sh-pause', other).classList.add('show'));
        });
      } else {
        player.pause();
        if (Math.abs(i - index) > 1 && player.getAttribute('src')) {
          player.removeAttribute('src'); player.load();
        }
      }
    });
    if (!viewed.has(node.dataset.id)) {
      viewed.add(node.dataset.id);
      const video = getVideo(node.dataset.id);
      video.views = (video.views || 0) + 1;
      DB.putVideo(video).catch(() => {}); DB.addHistory(video.id).catch(() => {});
    }
    $('#sh-prev').disabled = index === 0; $('#sh-next').disabled = index === nodes.length - 1;
  }
  const observer = new IntersectionObserver((entries) => {
    const best = entries.filter((entry) => entry.isIntersecting && entry.intersectionRatio >= .6)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (best) activate(best.target);
  }, { root: feed, threshold: [.6, .9] });
  nodes.forEach((node) => observer.observe(node));
  const initialFrame = requestAnimationFrame(() => activate(nodes[0]));
  function scrollByShort(direction) {
    const next = nodes[nodes.indexOf(activeNode) + direction];
    if (next) feed.scrollTo({ top: next.offsetTop, behavior: 'smooth' });
  }
  $('#sh-prev').addEventListener('click', () => scrollByShort(-1));
  $('#sh-next').addEventListener('click', () => scrollByShort(1));
  $('#sh-sound').addEventListener('click', () => {
    muted = !muted;
    if (activeNode) $('video', activeNode).muted = muted;
    $('#sh-sound').innerHTML = icon(muted ? 'volume-off' : 'volume');
    $('#sh-sound').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  });
  const onKey = (event) => {
    if (!$('#sheet-root').hidden || $('.upload-page') || event.target.matches('input,textarea')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scrollByShort(event.key === 'ArrowDown' ? 1 : -1); }
  };
  document.addEventListener('keydown', onKey);
  nodes.forEach((node) => {
    const player = $('video', node);
    node.addEventListener('click', (event) => {
      if (event.target.closest('button') || event.target.closest('.sh-info')) return;
      if (player.paused) { player.muted = muted; player.play().catch(() => {}); }
      else player.pause();
    });
    player.addEventListener('play', () => $('.sh-pause', node).classList.remove('show'));
    player.addEventListener('pause', () => { if (node === activeNode) $('.sh-pause', node).classList.add('show'); });
    player.addEventListener('error', () => { if (node === activeNode && player.getAttribute('src')) toast('Устройство не поддерживает формат этого ролика.'); });
    player.addEventListener('timeupdate', () => {
      $('.sh-progress i', node).style.width = player.duration ? player.currentTime / player.duration * 100 + '%' : '0%';
    });
    DB.listComments(node.dataset.id).then((comments) => { if (node.isConnected) $('.sh-comment-count', node).textContent = comments.length; });
    $$('.sh-rail button', node).forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = node.dataset.id, action = button.dataset.act;
      if (action === 'sh-like' || action === 'sh-dislike') {
        if (action === 'sh-like') await toggleLike(id); else await toggleDislike(id);
        const video = getVideo(id), like = $('[data-act="sh-like"]', node), dislike = $('[data-act="sh-dislike"]', node);
        like.classList.toggle('on', video.liked === 1); $('svg', like).classList.toggle('icon--fill', video.liked === 1);
        $('.cnt', like).textContent = video.likes ? fmtCount(video.likes) : 'Нравится';
        dislike.classList.toggle('on', video.liked === -1); $('svg', dislike).classList.toggle('icon--fill', video.liked === -1);
      } else if (action === 'sh-comments') openShortsComments(id);
      else if (action === 'sh-share') shareVideo(id);
      else if (action === 'sh-more') videoMenu(id);
    }));
  });
  cleanups.push(() => {
    observer.disconnect(); cancelAnimationFrame(initialFrame); document.removeEventListener('keydown', onKey);
    S.shortActive = null;
    nodes.forEach((node) => { const player = $('video', node); player.pause(); player.removeAttribute('src'); player.load(); });
  });
}

function openShortsComments(videoId) {
  DB.listComments(videoId).then((comments) => {
    openSheet(`
      <div class="sheet-title">Комментарии ${comments.length}</div>
      <div class="cm-input-row">
        ${avatarHTML(S.settings.channelName, '', S.settings.channelColor)}
        <input id="sh-cm-input" data-video="${videoId}" placeholder="Введите комментарий..." autocomplete="off">
        <button class="icon-btn" id="sh-cm-send">${icon('check')}</button>
      </div>
      <div id="sh-cm-list">
        ${comments.map((c) => `
          <div class="cm-item">
            ${avatarHTML(c.author, '', S.settings.channelColor)}
            <div class="cm-body">
              <div class="cm-author"><b>${esc(c.author)}</b> • ${timeAgo(c.at)}</div>
              <div class="cm-text">${esc(c.text)}</div>
            </div>
          </div>`).join('') || '<p style="padding:8px 24px 16px;color:var(--text-2);font-size:13.5px">Пока нет комментариев</p>'}
      </div>`);
    const inp = $('#sh-cm-input');
    const send = async () => {
      const text = inp.value.trim();
      if (!text) return;
      await DB.addComment(videoId, text, S.settings.channelName);
      closeSheet();
      toast('Комментарий добавлен');
    };
    $('#sh-cm-send').addEventListener('click', send);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  });
}

/* ============================== поиск ============================== */

async function viewSearch(view) {
  if (effectiveOffline()) S.searchSource = 'local';
  view.innerHTML = sourceStripHTML(S.searchSource, true) + '<div class="search-hint" id="search-body"></div>';
  const input = $('#search-input');
  input.value = S.searchQuery;
  renderSearchBody(input.value, S.searchExecute);
  S.searchExecute = false;
  let debounce = null;
  input.addEventListener('input', () => {
    S.searchQuery = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => renderSearchBody(input.value), 180);
  });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(input.value); });
  const focusTimer = setTimeout(() => input.focus(), 120);
  cleanups.push(() => { clearTimeout(debounce); clearTimeout(focusTimer); searchController?.abort(); searchGeneration++; });
}

async function renderSearchBody(query, execute = false, page = '') {
  const body = $('#search-body');
  if (!body) return;
  const ticket = ++searchGeneration;
  searchController?.abort();
  const controller = new AbortController(); searchController = controller;
  query = (query || '').trim();
  if (!query) {
    const recent = await DB.kvGet('recent', []);
    if (ticket !== searchGeneration || !body.isConnected) return;
    body.innerHTML = recent.map((text) => `<button class="hint-row" data-act="search-run" data-q="${esc(text)}">${icon('history')}<span>${esc(text)}</span>${icon('search')}</button>`).join('')
      + `<p class="search-explainer">${S.searchSource === 'youtube' ? 'Поиск настоящих видео YouTube. Нажмите Enter, чтобы выполнить запрос. Можно вставить ссылку на видео или Shorts.' : 'Поиск по вашим видео, Shorts и названиям каналов.'}</p>`
      + (recent.length ? '<button class="text-btn" id="clear-recent">Очистить историю поиска</button>' : '');
    $('#clear-recent')?.addEventListener('click', async () => { await DB.kvSet('recent', []); renderSearchBody(''); });
    return;
  }
  if (S.searchSource === 'youtube' && !effectiveOffline()) {
    const parsed = Media.parseYouTubeLink(query);
    if (parsed) {
      body.innerHTML = `<button class="hint-row" id="search-open-link">${icon(parsed.short ? 'shorts' : 'link')}<span>Открыть ${parsed.short ? 'Shorts' : 'видео'} YouTube</span>${icon('chev-r')}</button>`;
      $('#search-open-link').addEventListener('click', () => { location.hash = parsed.short ? '#/online-short/' + parsed.videoId : '#/watch/yt:' + parsed.videoId; });
      if (execute) $('#search-open-link').click();
      return;
    }
    if (!execute) {
      body.innerHTML = `<button class="hint-row" data-act="search-run" data-q="${esc(query)}">${icon('search')}<span>Найти «${esc(query)}» на YouTube</span>${icon('chev-r')}</button>`;
      return;
    }
    body.innerHTML = skeletonHTML();
    try {
      const response = await YouTube.search(query, controller.signal, page);
      if (ticket !== searchGeneration || !body.isConnected || effectiveOffline()) return;
      const videos = rememberOnline(response.items), shorts = videos.filter(isShort), regular = videos.filter((v) => !isShort(v));
      body.innerHTML = (shorts.length ? '<div class="section-head">Shorts</div>' + shortsGridHTML(shorts) : '')
        + regular.map(compactCardHTML).join('')
        + (!videos.length ? emptyHTML('search', 'Ничего не найдено', 'Попробуйте другой запрос.') : '')
        + (response.nextPage ? '<button class="btn-gray search-more" id="search-more">Следующие результаты</button>' : '');
      $('#search-more')?.addEventListener('click', () => renderSearchBody(query, true, response.nextPage));
    } catch (error) {
      if (ticket !== searchGeneration || error.name === 'AbortError') return;
      body.innerHTML = networkErrorHTML(error);
    }
    return;
  }
  const lower = query.toLocaleLowerCase('ru');
  const videos = S.videos.filter((video) => [video.title, video.description, video.channelName].some((text) => String(text || '').toLocaleLowerCase('ru').includes(lower)));
  const shorts = videos.filter(isShort), regular = videos.filter((video) => !isShort(video));
  body.innerHTML = (shorts.length ? '<div class="section-head">Shorts</div>' + shortsGridHTML(shorts) : '')
    + (regular.length ? '<div class="section-head">Видео</div>' + regular.map(compactCardHTML).join('') : '')
    + (!videos.length ? emptyHTML('search', 'Ничего не найдено', 'На устройстве нет подходящих роликов. Для онлайн-поиска выберите YouTube.') : '');
}

async function runSearch(query) {
  const input = $('#search-input');
  if (!input) return;
  query = (query || '').trim();
  input.value = query; S.searchQuery = query; input.blur();
  if (query) {
    const recent = await DB.kvGet('recent', []);
    await DB.kvSet('recent', [query, ...recent.filter((text) => text !== query)].slice(0, 8));
  }
  renderSearchBody(query, true);
}

/* ============================== канал / списки ============================== */

async function viewChannel(view, nameRaw) {
  const name = decodeURIComponent(nameRaw || '');
  const mine = S.videos.filter((v) => v.channelName === name);
  const shortsOnly = mine.filter(isShort);
  const regular = mine.filter((video) => !isShort(video));
  const subOn = S.settings.subs[name] !== false;
  const tab = S.channelTab || 'videos';

  view.innerHTML = `
    <div class="channel-banner" style="--channel-hue:${hueOf(name)}"></div>
    <div class="ch-head">
      ${avatarHTML(name, '', S.settings.channelColor)}
      <div class="tb-grow">
        <h1>${esc(name)}</h1>
        <p>${fmtSubs(1)} • ${mine.length} ${plural(mine.length, 'видео', 'видео', 'видео')}</p>
      </div>
    </div>
    <div style="padding:0 16px 14px">
      <button class="btn-sub ${subOn ? 'subed' : ''}" data-act="sub" data-ch="${esc(name)}" style="display:inline-flex">
        ${subOn ? `${icon('bell')}Вы подписаны${icon('chev-d')}` : 'Подписаться'}
      </button>
    </div>
    <div class="tabs">
      <button class="${tab === 'videos' ? 'on' : ''}" data-ctab="videos">Видео</button>
      <button class="${tab === 'shorts' ? 'on' : ''}" data-ctab="shorts">Shorts</button>
    </div>
    <div id="ch-list">
      ${tab === 'videos'
        ? (regular.length ? feedHTML(regular.slice().sort((a, b) => b.createdAt - a.createdAt))
          : emptyHTML('myvids', 'Нет видео', 'На этом канале пока нет видео.'))
        : (shortsOnly.length ? shortsGridHTML(shortsOnly) : emptyHTML('shorts', 'Нет Shorts', 'Вертикальные видео канала появятся здесь.'))}
    </div>`;

  $$('[data-ctab]', view).forEach((b) => b.addEventListener('click', () => {
    S.channelTab = b.dataset.ctab;
    render();
  }));
}

async function viewHistory(view) {
  const ticket = renderGeneration;
  const hs = await DB.listHistory();
  if (ticket !== renderGeneration) return;
  const rows = [];
  let lastDay = '';
  for (const h of hs) {
    const v = getVideo(h.videoId);
    if (!v) continue;
    const day = new Date(h.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const d = new Date(h.at);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const label = h.at >= today.getTime() ? 'Сегодня'
        : h.at >= today.getTime() - 86400000 ? 'Вчера'
        : fmtDate(h.at);
      rows.push(`<div class="group-title">${label}</div>`);
    }
    rows.push(compactCardHTML(v));
  }

  view.innerHTML = `
    ${hs.length ? `
      <button class="list-row" data-act="clear-history" style="margin-top:6px">
        ${icon('trash')}<span class="lr-label">Очистить историю просмотров</span>
      </button>
      <div class="list-sep"></div>
      ${rows.join('')}`
      : emptyHTML('history', 'Нет просмотров', 'Здесь появится история просмотренных видео.')}`;
}

async function viewMyVideos(view, downloads = false) {
  const videos = S.videos.filter((video) => !isShort(video)), shorts = S.videos.filter(isShort);
  view.innerHTML = `<div class="library-head"><h2>${downloads ? 'Видео на устройстве' : 'Ваши видео'}</h2><button class="icon-btn" data-act="upload" aria-label="Добавить">${icon('plus')}</button></div>
    <div class="tabs"><button class="${S.libraryTab === 'videos' ? 'on' : ''}" data-library-tab="videos">Видео <span>${videos.length}</span></button><button class="${S.libraryTab === 'shorts' ? 'on' : ''}" data-library-tab="shorts">Shorts <span>${shorts.length}</span></button></div>
    ${downloads ? '<p class="settings-note">Эти файлы уже на устройстве. Интернет для просмотра не нужен.</p>' : ''}
    ${S.libraryTab === 'shorts'
      ? (shorts.length ? shortsGridHTML(shorts) : emptyHTML('shorts', 'Пока нет Shorts', 'Можно добавить несколько файлов сразу.', '<button class="btn-blue" data-act="upload-video" data-type="short">Добавить Shorts</button>'))
      : (videos.length ? videos.map(compactCardHTML).join('') : emptyHTML('myvids', 'Пока нет обычных видео', 'Ваши Shorts находятся в соседней вкладке.', '<button class="btn-blue" data-act="upload-video" data-type="video">Добавить видео</button>'))}`;
  $$('[data-library-tab]', view).forEach((button) => button.addEventListener('click', () => { S.libraryTab = button.dataset.libraryTab; render(); }));
}

async function viewWatchLater(view) {
  const locals = S.videos.filter((video) => video.saved), online = [...S.onlineVideos.values()].filter((video) => video.saved);
  const shorts = locals.filter(isShort), videos = locals.filter((video) => !isShort(video));
  view.innerHTML = locals.length || online.length
    ? `<div class="section-head">Смотреть позже · ${locals.length + online.length}</div>` + videos.map(compactCardHTML).join('')
      + (shorts.length ? '<div class="section-head">Shorts на устройстве</div>' + shortsGridHTML(shorts) : '')
      + (online.length ? '<div class="section-head">Ссылки YouTube</div><p class="settings-note">Это ссылки, не скачанные файлы. Для просмотра нужен интернет.</p>' + online.map(compactCardHTML).join('') : '')
    : emptyHTML('clock', 'Список пуст', 'Сохраняйте файлы и онлайн-ссылки, чтобы найти их позже.');
}

async function viewSettings(view) {
  const theme = S.settings.theme;
  view.innerHTML = `<div class="group-title">Подключение и офлайн</div>
    <button class="set-row" data-act="toggle-offline" role="switch" aria-checked="${S.settings.offlineMode}">
      ${icon('wifi-off')}<span class="sr-label"><b>Офлайн-режим</b><span>Только файлы на устройстве. Онлайн-запросы, плееры и превью отключены.</span></span><span class="switch ${S.settings.offlineMode ? 'on' : ''}"></span>
    </button>
    <button class="set-row" data-act="toggle-auto-offline" role="switch" aria-checked="${S.settings.autoOffline}">
      ${icon('refresh')}<span class="sr-label"><b>Автоматически без интернета</b><span>При потере подключения переходить к локальным видео</span></span><span class="switch ${S.settings.autoOffline ? 'on' : ''}"></span>
    </button>
    <div class="connection-detail">${icon(S.networkAvailable ? 'globe' : 'wifi-off')}<span>${effectiveOffline() ? 'Сейчас офлайн. Файлы и Shorts доступны.' : 'Онлайн-запросы разрешены. Доступность серверов зависит от сети.'}</span></div>
    <button class="list-row" data-act="open-downloads">${icon('download')}<span class="lr-label">Видео для офлайн-просмотра</span><span class="lr-value">${S.videos.length}</span>${icon('chev-r', 'lr-chev')}</button>

    <div class="group-title">Источник YouTube</div>
    <div class="chips settings-chips"><button class="chip ${S.settings.onlineProvider === 'official' ? 'on' : ''}" data-act="online-provider" data-provider="official">Официальный</button>
      <button class="chip ${S.settings.onlineProvider === 'invidious' ? 'on' : ''}" data-act="online-provider" data-provider="invidious">Свой сервер Invidious</button></div>
    ${S.settings.onlineProvider === 'official' ? `<button class="list-row" data-act="edit-api-key">${icon('key')}<span class="lr-label">Ключ YouTube Data API v3</span><span class="lr-value">${S.settings.youtubeApiKey ? 'Добавлен' : 'Не задан'}</span>${icon('chev-r', 'lr-chev')}</button>
      <p class="settings-note">Нужен для поиска и популярной ленты. Официальный плеер по ссылке работает без API-ключа. Ключ хранится только на устройстве и отправляется Google при запросе.</p>`
      : `<button class="list-row" data-act="edit-instance">${icon('globe')}<span class="lr-label">Адрес HTTPS-сервера</span>${icon('chev-r', 'lr-chev')}</button>
        <p class="settings-note instance-address">${esc(S.settings.invidiousInstance || 'Адрес не задан')}</p>
        <button class="set-row" data-act="toggle-proxy" role="switch" aria-checked="${S.settings.proxyPlayback}">${icon('shield')}<span class="sr-label"><b>Видеопотоки через сервер</b><span>Не обращаться напрямую к Google Video. Сервер должен поддерживать проксирование.</span></span><span class="switch ${S.settings.proxyPlayback ? 'on' : ''}"></span></button>
        <p class="settings-note">Используйте свой или доверенный Invidious-сервер с работающим API. В браузерной версии нужен CORS. Поисковые запросы и просмотр будут видны оператору сервера.</p>`}
    <button class="list-row" data-act="youtube-link">${icon('link')}<span class="lr-label">Открыть ссылку YouTube</span>${icon('chev-r', 'lr-chev')}</button>
    <p class="settings-note">Отсутствие блокировок РКН не гарантируется. Офлайн-режим не обходит блокировки и не скачивает видео YouTube.</p>

    <div class="group-title">Внешний вид</div><div class="set-row">${icon('palette')}<span class="sr-label"><b>Тема</b><span>Светлая, тёмная или как в системе</span></span></div>
    <div class="chips settings-chips"><button class="chip ${theme === 'light' ? 'on' : ''}" data-act="theme" data-theme-v="light">Светлая</button>
      <button class="chip ${theme === 'dark' ? 'on' : ''}" data-act="theme" data-theme-v="dark">Тёмная</button><button class="chip ${theme === 'system' ? 'on' : ''}" data-act="theme" data-theme-v="system">Системная</button></div>
    <div class="group-title">Воспроизведение</div>
    <button class="set-row" data-act="toggle-autoplay" role="switch" aria-checked="${S.settings.autoplayNext}">${icon('play', 'icon--fill')}<span class="sr-label"><b>Автовоспроизведение</b><span>Следующий локальный ролик после окончания</span></span><span class="switch ${S.settings.autoplayNext ? 'on' : ''}"></span></button>
    <div class="group-title">Канал</div><button class="list-row" data-act="edit-channel">${icon('edit')}<span class="lr-label">Название канала</span><span class="lr-value">${esc(S.settings.channelName)}</span>${icon('chev-r', 'lr-chev')}</button>
    <div class="group-title">Данные</div><button class="list-row" data-act="clear-history">${icon('history')}<span class="lr-label">Очистить историю просмотров</span>${icon('chev-r', 'lr-chev')}</button>
    <button class="list-row danger" data-act="wipe-all">${icon('trash')}<span class="lr-label">Удалить все локальные данные</span>${icon('chev-r', 'lr-chev')}</button>
    <div class="about-note">${icon('info')}<div><b>YouTube Local 1.1</b><br>Самостоятельный клиент, не официальное приложение Google. Импортированные файлы не отправляются на сервер. Локальные комментарии, лайки и подписки не публикуются в YouTube.</div></div>`;
}

async function changeSetting(name, value) {
  S.settings[name] = value;
  const scroll = $('#view').scrollTop;
  syncNetworkSettings();
  try {
    await DB.kvSet(name, value);
    if (name === 'offlineMode' || name === 'autoOffline') {
      try { localStorage.setItem(name, String(value)); } catch (_) {}
    }
  } catch (error) {
    toast('Не удалось сохранить настройку. Сейчас она действует, но может сброситься при перезапуске. Проверьте свободное место.');
  }
  closeSheet(); render(); $('#view').scrollTop = scroll;
}
function toggleOffline() { return changeSetting('offlineMode', !S.settings.offlineMode); }
function toggleAutoOffline() { return changeSetting('autoOffline', !S.settings.autoOffline); }
function toggleProxy() { return changeSetting('proxyPlayback', !S.settings.proxyPlayback); }
function setOnlineProvider(provider) { return changeSetting('onlineProvider', provider === 'invidious' ? 'invidious' : 'official'); }
function editApiKey() {
  formSheet({ title: 'YouTube Data API v3', fields: [{ name: 'key', label: 'Свой API-ключ (пустое поле удалит ключ)', type: 'password', value: S.settings.youtubeApiKey, placeholder: 'API key из Google Cloud Console' }],
    onOk: ({ key }) => changeSetting('youtubeApiKey', key.trim()) });
}
function editInstance() {
  formSheet({ title: 'Свой сервер Invidious', fields: [{ name: 'url', label: 'HTTPS-адрес доверенного сервера', type: 'url', value: S.settings.invidiousInstance, placeholder: 'https://ваш-сервер.example' }],
    onOk: ({ url }) => {
      try { return changeSetting('invidiousInstance', url.trim() ? Media.instanceURL(url) : ''); }
      catch (error) { toast(error.message); }
    } });
}

/* ============================== загрузка видео ============================== */

function openUpload(preferredType = 'auto') {
  if ($('.upload-page')) { toast('Сначала завершите текущий импорт.'); return; }
  const root = document.createElement('div');
  root.className = 'upload-page';
  root.innerHTML = `<div class="up-bar"><button class="icon-btn" id="up-close" aria-label="Закрыть">${icon('back')}</button>
    <h1>${preferredType === 'short' ? 'Добавить Shorts' : 'Добавить видео'}</h1></div>
    <div class="up-body" id="up-body"></div><div class="up-foot" id="up-foot" hidden></div>`;
  document.body.appendChild(root);
  const body = $('#up-body', root), foot = $('#up-foot', root);
  let picked = [], busy = false, closed = false;
  let controller = null;
  const urls = new Set();
  function objectURL(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
  function release() {
    $$('video', root).forEach((video) => { video.pause(); video.removeAttribute('src'); video.load(); });
    urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear();
  }
  function close() {
    if (busy) { toast('Дождитесь сохранения файлов.'); return; }
    closed = true; controller?.abort(); release(); root.remove();
  }
  $('#up-close', root).addEventListener('click', close);
  function stepPick() {
    controller?.abort(); release(); picked = []; busy = false;
    foot.hidden = true;
    body.innerHTML = `<div class="up-pick">${icon(preferredType === 'short' ? 'shorts' : 'folder-up')}
      <b>${preferredType === 'short' ? 'Выберите один или несколько Shorts' : 'Выберите видео на устройстве'}</b>
      <span>Можно выбрать несколько файлов сразу. Они останутся на устройстве и будут доступны без интернета.</span>
      <button class="btn-blue" id="up-choose">Выбрать файлы</button></div>
      <input type="file" id="up-file" accept="video/*" multiple hidden>`;
    $('#up-choose', body).addEventListener('click', () => $('#up-file', body).click());
    $('#up-file', body).addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) return;
      controller = new AbortController();
      body.innerHTML = `<div class="up-processing">${icon('refresh')}<span id="up-process-label"></span></div>`;
      let failed = 0;
      for (let index = 0; index < files.length; index++) {
        if (closed || controller.signal.aborted) return;
        $('#up-process-label', body).textContent = `Читаем файл ${index + 1} из ${files.length}…`;
        try {
          const meta = await extractMeta(files[index], controller.signal);
          if (closed || controller.signal.aborted) return;
          const file = files[index];
          const shortAllowed = meta.duration <= Media.SHORT_MAX_SECONDS;
          const type = preferredType === 'short' && shortAllowed ? 'short'
            : preferredType === 'video' ? 'video' : Media.inferType(meta);
          picked.push({ id: 'v' + uid(), file, meta, type, published: false });
        } catch (error) {
          if (error.name === 'AbortError') return;
          failed++;
        }
      }
      if (closed) return;
      if (!picked.length) { stepPick(); toast('Не удалось прочитать файлы. Попробуйте видео MP4 с поддерживаемым кодеком.'); return; }
      stepForm();
      if (failed) toast(`Не удалось прочитать файлов: ${failed}. Остальные готовы к сохранению.`);
    });
  }
  function stepForm() {
    body.innerHTML = `<div class="batch-summary">${picked.length > 1 ? `Выбрано файлов: ${picked.length}` : 'Сведения о видео'}<span>Сохранение на устройстве, не публикация в YouTube</span></div>
      <div class="up-batch">${picked.map(({ file, meta, type }, index) => {
        const title = (file.name || 'Видео').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Без названия';
        return `<section class="up-entry" data-index="${index}">
          <div class="up-entry-head"><img src="${meta.thumb ? objectURL(meta.thumb) : placeholderThumb}" alt=""><div><b>${esc(file.name)}</b><span>${fmtDur(meta.duration)} · ${(file.size / 1048576).toFixed(1)} МБ</span></div></div>
          <div class="up-fields"><div><label for="up-title-${index}">Название</label><input id="up-title-${index}" class="up-title-input" value="${esc(title)}" maxlength="120" required></div>
            <div class="upload-types"><label><input type="radio" name="up-type-${index}" value="video" ${type === 'video' ? 'checked' : ''}>${icon('myvids')}Видео</label>
              <label><input type="radio" name="up-type-${index}" value="short" ${type === 'short' ? 'checked' : ''} ${meta.duration > Media.SHORT_MAX_SECONDS ? 'disabled' : ''}>${icon('shorts', 'icon--fill')}Shorts</label></div>
            ${meta.duration > Media.SHORT_MAX_SECONDS ? '<p class="field-note">Этот ролик длиннее 3 минут — будет обычным видео.</p>' : '<p class="field-note">Shorts появятся только в своей ленте и на полках Shorts.</p>'}
            <details><summary>Добавить описание</summary><textarea class="up-description-input" placeholder="Описание"></textarea></details>
          </div><div class="up-entry-error" role="status"></div>
        </section>`;
      }).join('')}</div><div class="up-progress" id="up-prog" hidden><i></i></div>`;
    foot.hidden = false;
    foot.innerHTML = `<button class="btn-gray" id="up-cancel">Назад</button><button class="btn-blue" id="up-publish">Сохранить ${picked.length > 1 ? `(${picked.length})` : ''}</button>`;
    $('#up-cancel', foot).addEventListener('click', stepPick);
    $('#up-publish', foot).addEventListener('click', publish);
  }
  async function publish() {
    if (busy || closed) return;
    const entries = $$('.up-entry', body);
    const todo = picked.filter((item) => !item.published);
    for (const entry of entries) {
      const item = picked[Number(entry.dataset.index)];
      if (item.published) continue;
      item.title = $('.up-title-input', entry).value.trim();
      if (!item.title) { toast('Введите название каждого ролика.'); $('.up-title-input', entry).focus(); return; }
      item.description = $('.up-description-input', entry).value.trim();
      item.type = $('input[type="radio"]:checked', entry).value;
    }
    busy = true;
    $$('button, input, textarea', root).forEach((element) => { element.disabled = true; });
    const progress = $('#up-prog', body); progress.hidden = false;
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (_) {}
    let completed = 0, failed = 0;
    for (const item of todo) {
      const { file, meta } = item;
      const video = { id: item.id, title: item.title, description: item.description,
        contentType: item.type, channelName: S.settings.channelName, createdAt: Date.now(),
        views: 0, likes: 0, dislikes: 0, liked: 0, saved: false,
        duration: meta.duration, w: meta.w, h: meta.h, thumb: meta.thumb, file,
        fileName: file.name || item.title + '.mp4', mime: file.type || 'video/mp4' };
      try {
        await DB.putVideo(video);
        item.published = true;
        $('.up-entry-error', entries[picked.indexOf(item)]).textContent = 'Сохранено';
      } catch (error) {
        failed++;
        $('.up-entry-error', entries[picked.indexOf(item)]).textContent = 'Не удалось сохранить. Проверьте свободное место и квоту хранилища.';
      }
      completed++; $('i', progress).style.width = completed / todo.length * 100 + '%';
    }
    await reloadVideos(); busy = false;
    $$('button, input, textarea', root).forEach((element) => { element.disabled = false; });
    // Не теряем ограничения выбора типа, когда включаем форму после ошибки.
    entries.forEach((entry, index) => {
      if (picked[index].meta.duration > Media.SHORT_MAX_SECONDS) $('input[value="short"]', entry).disabled = true;
      if (picked[index].published) $$('input,textarea', entry).forEach((element) => { element.disabled = true; });
    });
    if (failed) {
      progress.hidden = true; $('#up-publish', foot).textContent = 'Повторить несохранённые';
      toast(`Сохранено: ${picked.filter((item) => item.published).length}. Не сохранено: ${failed}.`);
      render(); return;
    }
    const saved = picked.filter((item) => item.published);
    const shorts = saved.filter((item) => item.type === 'short').length;
    release();
    body.innerHTML = `<div class="up-done">${icon('check')}<h2>${saved.length > 1 ? `Сохранено роликов: ${saved.length}` : 'Ролик сохранён'}</h2>
      <p>${shorts ? `Shorts: ${shorts}. ` : ''}${saved.length - shorts ? `Обычных видео: ${saved.length - shorts}. ` : ''}Все файлы доступны без интернета.</p>
      <div class="btns"><button class="btn-gray" id="done-home">На главную</button><button class="btn-blue" id="done-watch">Смотреть</button></div>
      <button class="text-btn" id="done-more">${icon('plus')}Добавить ещё</button></div>`;
    foot.hidden = true;
    $('#done-more', body).addEventListener('click', stepPick);
    $('#done-home', body).addEventListener('click', () => { close(); S.settings.homeSource = 'local'; DB.kvSet('homeSource', 'local'); location.hash = '#/home'; render(); });
    $('#done-watch', body).addEventListener('click', () => { close(); navigateVideo(saved[0].id); });
    render();
  }
  stepPick();
}

function once(element, name, timeout = 10000, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new Error('Unsupported video')); };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    function cleanup() {
      clearTimeout(timer); element.removeEventListener(name, ok); element.removeEventListener('error', error);
      signal?.removeEventListener('abort', abort);
    }
    element.addEventListener(name, ok, { once: true }); element.addEventListener('error', error, { once: true });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function extractMeta(file, signal) {
  const url = URL.createObjectURL(file), video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  try {
    // Слушатель ДО src: на маленьких/повторно выбранных файлах событие может прийти сразу.
    const metadata = once(video, 'loadedmetadata', 12000, signal);
    video.src = url; video.load(); await metadata;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) throw new Error('No video track');
    let thumb = null;
    try {
      if (video.readyState < 2) await once(video, 'loadeddata', 7000, signal);
      if (duration > .15) {
        const seek = once(video, 'seeked', 5000, signal);
        video.currentTime = Math.min(duration * .25, 2); await seek;
      }
      const canvas = document.createElement('canvas'), scale = Math.min(1, 480 / Math.max(w, h));
      canvas.width = Math.max(2, Math.round(w * scale)); canvas.height = Math.max(2, Math.round(h * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      thumb = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .8));
    } catch (error) { if (error.name === 'AbortError') throw error; }
    return { duration, w, h, thumb };
  } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

/* ============================== установка приложения ============================== */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const host = $('#install-host');
  if (host && !host.innerHTML) host.innerHTML = installBtnHTML();
});

function installBtnHTML() {
  return `
    <button class="list-row" data-act="install-app">
      ${icon('folder-up')}<span class="lr-label">Установить как приложение</span>${icon('chev-r', 'lr-chev')}
    </button>`;
}

async function doInstall() {
  if (!installPrompt) {
    toast('Откройте меню браузера и выберите «На экран «Домой»»');
    return;
  }
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch (_) {}
  installPrompt = null;
  render();
}

/* ============================== роутер ============================== */

let cleanups = [];

function runCleanups() {
  cleanups.forEach((fn) => { try { fn(); } catch (_) {} });
  cleanups = [];
}

function parseHash() {
  const h = (location.hash || '#/home').replace(/^#\/?/, '');
  const [name = 'home', ...rest] = h.split('/');
  return [name, rest.join('/')];
}

// Android Back закрывает сначала плеер/листы/загрузку, затем возвращает по вкладкам.
window.handleAndroidBack = () => {
  if (document.fullscreenElement) { document.exitFullscreen(); return true; }
  const upload = $('.upload-page #up-close');
  if (upload) { upload.click(); return true; }
  if (!$('#sheet-root').hidden) { closeSheet(); return true; }
  if (location.hash && location.hash !== '#/home') {
    if (history.length > 1) history.back(); else location.hash = '#/home';
    return true;
  }
  return false;
};

function render() {
  renderGeneration++;
  runCleanups();
  const [name, arg] = parseHash();
  if (name !== 'watch') S._watchVisit = null;
  const view = $('#view');
  view.scrollTop = 0;
  view.innerHTML = '';

  document.body.dataset.page = name;
  document.body.dataset.nav = name === 'watch' || name === 'online-short' ? 'hidden' : '';
  updateConnectionBanner();
  if (window.NativeApp) window.NativeApp.setBars(resolvedTheme() === 'dark' || name === 'shorts');
  const top = $('#topbar');

  switch (name) {
    case 'home':
      S.lastTab = 'home';
      top.innerHTML = topMainHTML();
      viewHome(view);
      break;
    case 'shorts':
      S.lastTab = 'shorts';
      top.innerHTML = '';
      viewShorts(view);
      break;
    case 'subs':
      S.lastTab = 'subs';
      top.innerHTML = topMainHTML();
      viewSubs(view);
      break;
    case 'you':
      S.lastTab = 'you';
      top.innerHTML = topMainHTML();
      viewYou(view);
      break;
    case 'online-short':
      top.innerHTML = '';
      viewOnlineWatch(view, arg, true);
      break;
    case 'watch':
      top.innerHTML = '';
      viewWatch(view, arg);
      break;
    case 'search':
      top.innerHTML = topSearchHTML(S.searchQuery);
      viewSearch(view);
      break;
    case 'channel':
      top.innerHTML = topTitleHTML('Канал');
      viewChannel(view, arg);
      break;
    case 'history':
      top.innerHTML = topTitleHTML('История');
      viewHistory(view);
      break;
    case 'my-videos':
      top.innerHTML = topTitleHTML('Ваши видео');
      viewMyVideos(view);
      break;
    case 'watch-later':
      top.innerHTML = topTitleHTML('Смотреть позже');
      viewWatchLater(view);
      break;
    case 'downloads':
      top.innerHTML = topTitleHTML('Видео на устройстве');
      viewMyVideos(view, true);
      break;
    case 'settings':
      top.innerHTML = topTitleHTML('Настройки');
      viewSettings(view);
      break;
    default:
      location.hash = '#/home';
      return;
  }

  $$('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.tab === S.lastTab && name !== 'search');
    n.setAttribute('aria-current', n.classList.contains('active') ? 'page' : 'false');
    if (n.dataset.tab === 'home') n.querySelector('use').setAttribute('href', n.classList.contains('active') ? '#i-home' : '#i-home-outline');
  });
}

/* ============================== запуск ============================== */

async function boot() {
  const theme = await DB.kvGet('theme', 'light');
  const channelName = await DB.kvGet('channelName', 'Мой канал');
  const channelColor = await DB.kvGet('channelColor', 262);
  const autoplayNext = await DB.kvGet('autoplayNext', true);
  const subs = await DB.kvGet('subs', {});
  Object.assign(S.settings, { theme, channelName, channelColor, autoplayNext, subs });
  for (const key of ['offlineMode','autoOffline','homeSource','onlineProvider','youtubeApiKey','invidiousInstance','proxyPlayback']) {
    S.settings[key] = await DB.kvGet(key, S.settings[key]);
  }
  S.onlineState = await DB.kvGet('onlineState', {});
  S.onlineSaved = await DB.kvGet('onlineSaved', []);
  rememberOnline(await DB.kvGet('onlineHistoryMeta', []));
  rememberOnline(S.onlineSaved);
  S.searchSource = effectiveOffline() ? 'local' : S.settings.homeSource;
  S.booted = true;
  syncNetworkSettings();
  applyTheme();
  await reloadVideos();

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/home';
  render();

  // В APK интерфейс уже внутри пакета; не кэшируем его второй раз через SW.
  if (location.hostname !== 'appassets.androidplatform.net' && 'serviceWorker' in navigator && navigator.serviceWorker) {
    navigator.serviceWorker.register('sw.js').then(() => {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        navigator.serviceWorker.controller?.postMessage({ type: 'SET_OFFLINE', enabled: effectiveOffline() });
      });
    }).catch(() => {});
  }
}

boot().catch((error) => {
  $('#view').innerHTML = emptyHTML('info', 'Не удалось открыть хранилище', 'Разрешите хранение данных сайта или проверьте свободное место на устройстве.');
  console.error('Local storage initialization failed:', error.name);
});
