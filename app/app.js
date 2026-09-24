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
    subs: {}                   // channelName -> bool
  },
  videos: [],
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
  return S.videos.find((v) => v.id === id);
}

async function reloadVideos() {
  S.videos = await DB.listVideos();
}

function isShort(v) {
  return (v.h || 0) > (v.w || 0);
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
            : `<input id="f-${f.name}" name="${f.name}" value="${esc(f.value || '')}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`}
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
  return `
  <article class="vcard">
    <div class="vthumb" data-act="watch" data-id="${v.id}">
      <img src="${thumbURL(v)}" alt="" loading="lazy">
      <span class="dur">${fmtDur(v.duration)}</span>
    </div>
    <div class="vmeta">
      ${avatarHTML(v.channelName, '', S.settings.channelColor)}
      <div class="vtext" data-act="watch" data-id="${v.id}">
        <h3 class="vtitle">${esc(v.title)}</h3>
        <div class="vsub">${esc(v.channelName)} • ${fmtViews(v.views || 0)} • ${timeAgo(v.createdAt)}</div>
      </div>
      <button class="vmore" data-act="card-menu" data-id="${v.id}" aria-label="Ещё">${icon('more-v')}</button>
    </div>
  </article>`;
}

function compactCardHTML(v) {
  return `
  <article class="ccard">
    <div class="cthumb" data-act="watch" data-id="${v.id}">
      <img src="${thumbURL(v)}" alt="" loading="lazy">
      <span class="dur">${fmtDur(v.duration)}</span>
    </div>
    <div class="ctext" data-act="watch" data-id="${v.id}">
      <h3 class="ctitle">${esc(v.title)}</h3>
      <div class="csub">${esc(v.channelName)} • ${fmtViews(v.views || 0)} • ${timeAgo(v.createdAt)}</div>
    </div>
    <button class="vmore" data-act="card-menu" data-id="${v.id}" aria-label="Ещё">${icon('more-v')}</button>
  </article>`;
}

function shortsShelfHTML(items) {
  return `
  <section class="shorts-shelf">
    <div class="shelf-head">
      <svg class="icon shorts-logo icon--fill"><use href="#i-shorts"/></svg>
      <h2>Shorts</h2>
    </div>
    <div class="shelf-scroll">
      ${items.map((v) => `
        <div class="shorts-tile" data-act="open-shorts" data-id="${v.id}">
          <img src="${thumbURL(v)}" alt="" loading="lazy">
          <div class="st-title">${esc(v.title)}</div>
        </div>`).join('')}
    </div>
  </section>`;
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
    <button class="icon-btn" data-act="cast" aria-label="Трансляция">${icon('cast')}</button>
    <button class="icon-btn" data-act="open-search" aria-label="Поиск">${icon('search')}</button>
    <button class="icon-btn" data-act="tab" data-tab="you" aria-label="Профиль">
      ${avatarHTML(S.settings.channelName, 'tb-avatar', S.settings.channelColor)}
    </button>
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
      location.hash = '#/watch/' + id;
      break;
    case 'open-shorts':
      S.shortStart = id;
      location.hash = '#/shorts';
      break;
    case 'open-search':
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
      toast('Приложение работает локально — трансляция не нужна');
      break;
    case 'mic':
      toast('Голосовой поиск недоступен офлайн');
      break;
    case 'upload':
      openUpload();
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
      if (b) b.classList.toggle('clamp');
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
      if (inp) { inp.value = ''; inp.focus(); renderSearchBody(''); }
      break;
    }
    case 'search-run':
      runSearch(t.dataset.q);
      break;
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

async function shareVideo(id) {
  const v = getVideo(id);
  if (!v) return;
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
  const rows = [
    {
      icon: v.saved ? 'saved' : 'save',
      label: v.saved ? 'Убрать из «Смотреть позже»' : 'Сохранить в «Смотреть позже»',
      onClick: () => toggleSave(id)
    },
    { icon: 'share', label: 'Поделиться', onClick: () => shareVideo(id) },
    { icon: 'download', label: 'Скачать файл', onClick: () => downloadVideo(id) },
    { icon: 'edit', label: 'Изменить название и описание', onClick: () => editVideo(id) },
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
  if (subBtn && $('#player') && subBtn.dataset.ch === channelName) {
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
  applyTheme();
  render();
}

async function toggleAutoplay() {
  S.settings.autoplayNext = !S.settings.autoplayNext;
  await DB.kvSet('autoplayNext', S.settings.autoplayNext);
  render();
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
    await reloadVideos();
    toast('Все данные удалены');
    location.hash = '#/home';
    render();
  });
}

/* ============================== страницы ============================== */

const CHIPS = [
  { id: 'all', label: 'Все' },
  { id: 'new', label: 'Новые' },
  { id: 'pop', label: 'Популярные' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'long', label: 'Длинные' }
];

async function viewHome(view) {
  let list = S.videos.slice();
  const shorts = shuffle(list.filter(isShort));

  switch (S.filter) {
    case 'new': list.sort((a, b) => b.createdAt - a.createdAt); break;
    case 'pop': list.sort((a, b) => (b.views || 0) - (a.views || 0)); break;
    case 'shorts': list = shorts; break;
    case 'long': list = shuffle(list.filter((v) => (v.duration || 0) >= 240)); break;
    default: list = shuffle(list); break;
  }
  S.reshuffle = false;

  if (!S.videos.length) {
    view.innerHTML = emptyHTML(
      'folder-up',
      'Здесь появятся ваши видео',
      'Загрузите видео с телефона, назовите как угодно — и они будут появляться в рекомендациях. Всё хранится только на устройстве.',
      `<button class="btn-primary" data-act="upload">${icon('plus')}Загрузить видео</button>`
    );
    return;
  }

  const chips = CHIPS.map((c) => `<button class="chip ${S.filter === c.id ? 'on' : ''}" data-act="chip" data-chip="${c.id}">${c.label}</button>`).join('');
  let feed = '';

  if (S.filter === 'shorts') {
    feed = list.length ? feedHTML(list) : emptyHTML('shorts', 'Нет коротких видео', 'Загрузите вертикальное видео, чтобы оно появилось в Shorts.');
  } else if (S.filter === 'long') {
    feed = list.length ? feedHTML(list) : emptyHTML('clock', 'Нет длинных видео', 'Здесь будут видео длиной от 4 минут.');
  } else if (S.filter === 'all' && list.length > 1 && shorts.length) {
    // лента с полкой Shorts после первого видео — как в мобильном YouTube
    const [first, ...rest] = list;
    feed = `<div class="feed">${videoCardHTML(first)}</div>` + shortsShelfHTML(shorts.slice(0, 8)) + feedHTML(rest);
  } else {
    feed = feedHTML(list);
  }

  view.innerHTML = `<div class="chips">${chips}</div>${feed}`;
}

async function viewSubs(view) {
  if (!S.videos.length) {
    view.innerHTML = emptyHTML(
      'subs',
      'Нет новых видео',
      'Загрузите своё первое видео — оно появится в ленте подписок.',
      `<button class="btn-primary" data-act="upload">${icon('plus')}Загрузить видео</button>`
    );
    return;
  }
  const list = S.videos.slice().sort((a, b) => b.createdAt - a.createdAt);
  view.innerHTML = `<div class="section-head">Последние</div>` + feedHTML(list);
}

async function viewYou(view) {
  const name = S.settings.channelName;
  const hist = (await DB.listHistory()).slice(0, 12);
  const histVideos = [];
  for (const h of hist) {
    const v = getVideo(h.videoId);
    if (v && !histVideos.find((x) => x.id === v.id)) histVideos.push(v);
  }
  const later = S.videos.filter((v) => v.saved);

  view.innerHTML = `
    <div class="you-head" data-act="open-channel" data-ch="${esc(name)}">
      ${avatarHTML(name, '', S.settings.channelColor)}
      <div class="tb-grow">
        <h1>${esc(name)}</h1>
        <p>Локальный канал • ${fmtSubs(1)}</p>
      </div>
      ${icon('chev-r', 'lr-chev')}
    </div>
    <button class="list-row" data-act="open-history">${icon('history')}<span class="lr-label">История</span>${icon('chev-r', 'lr-chev')}</button>
    <button class="list-row" data-act="open-my-videos">${icon('myvids')}<span class="lr-label">Ваши видео</span><span class="lr-value">${S.videos.length}</span>${icon('chev-r', 'lr-chev')}</button>
    <button class="list-row" data-act="open-watch-later">${icon('clock')}<span class="lr-label">Смотреть позже</span><span class="lr-value">${later.length}</span>${icon('chev-r', 'lr-chev')}</button>
    <button class="list-row" data-act="open-settings">${icon('gear')}<span class="lr-label">Настройки</span>${icon('chev-r', 'lr-chev')}</button>
    <div id="install-host">${installPrompt ? installBtnHTML() : ''}</div>
    ${histVideos.length ? `
      <div class="group-title">Недавно просмотренные</div>
      <div class="hscroll">
        ${histVideos.map((v) => `
          <div class="hcard" data-act="watch" data-id="${v.id}">
            <div class="hthumb"><img src="${thumbURL(v)}" alt=""></div>
            <div class="htitle">${esc(v.title)}</div>
            <div class="hsub">${esc(v.channelName)}</div>
          </div>`).join('')}
      </div>` : ''}
    <div class="about-note">
      ${icon('eye')}
      <div>Все видео, комментарии и история хранятся только на этом устройстве. Ничего не отправляется в интернет.</div>
    </div>`;
}

async function viewWatch(view, id) {
  const v = getVideo(id);
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
  const recs = shuffle(S.videos.filter((x) => x.id !== v.id));
  const subOn = S.settings.subs[v.channelName] !== false;
  const chCount = S.videos.filter((x) => x.channelName === v.channelName).length;

  view.innerHTML = `
  <div class="watch">
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

    <h1 class="w-title">${esc(v.title)}</h1>
    <div class="w-meta">
      <span>${fmtViews(v.views)} • ${timeAgo(v.createdAt)}</span>
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

    <div class="w-channel">
      ${avatarHTML(v.channelName, '', S.settings.channelColor)}
      <div class="ch-text" data-act="open-channel" data-ch="${esc(v.channelName)}">
        <div class="ch-name">${esc(v.channelName)}</div>
        <div class="ch-subs">${fmtSubs(1)} • ${chCount} ${plural(chCount, 'видео', 'видео', 'видео')}</div>
      </div>
      <button class="btn-sub ${subOn ? 'subed' : ''}" data-act="sub" data-ch="${esc(v.channelName)}">
        ${subOn ? `${icon('bell')}Вы подписаны${icon('chev-d')}` : 'Подписаться'}
      </button>
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
    view.innerHTML = emptyHTML(
      'shorts',
      'Попробуйте Shorts',
      'Загрузите вертикальное видео — оно появится в этой ленте.',
      `<button class="btn-primary" data-act="upload">${icon('plus')}Загрузить видео</button>`
    );
    return;
  }

  items = shuffle(items);
  if (S.shortStart) {
    const i = items.findIndex((x) => x.id === S.shortStart);
    if (i > 0) items = [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
    S.shortStart = null;
  }

  view.innerHTML = `
  <div class="shorts-page">
    <div class="shorts-top">
      <h1>Shorts</h1>
      <button class="icon-btn" data-act="open-search" aria-label="Поиск">${icon('search')}</button>
    </div>
    <div class="shorts-feed" id="shorts-feed">
      ${items.map((v) => `
        <div class="short" data-id="${v.id}">
          <video playsinline loop preload="${v === items[0] ? 'auto' : 'metadata'}" src="${fileURL(v)}" poster="${thumbURL(v)}"></video>
          <div class="sh-pause">${icon('play', 'icon--fill')}</div>
          <div class="sh-info">
            <div class="sh-ch">${avatarHTML(v.channelName, '', S.settings.channelColor)}<span>${esc(v.channelName)}</span></div>
            <div class="sh-title">${esc(v.title)}</div>
          </div>
          <div class="sh-rail">
            <button data-act="sh-like" class="${v.liked === 1 ? 'on' : ''}">${icon('like', v.liked === 1 ? 'icon--fill' : '')}<span class="cnt">${v.likes > 0 ? fmtCount(v.likes) : ''}</span></button>
            <button data-act="sh-dislike" class="${v.liked === -1 ? 'on' : ''}">${icon('dislike', v.liked === -1 ? 'icon--fill' : '')}</button>
            <button data-act="sh-comments">${icon('comment')}</button>
            <button data-act="sh-share">${icon('share')}</button>
            <button data-act="sh-more">${icon('more-v')}</button>
          </div>
          <div class="sh-progress"><i></i></div>
        </div>`).join('')}
    </div>
  </div>`;

  const feed = $('#shorts-feed');
  const shorts = $$('.short', feed);

  S.shortActive = null;

  function activate(node) {
    shorts.forEach((n) => {
      const vid = n.querySelector('video');
      if (n === node) {
        S.shortActive = getVideo(n.dataset.id);
        vid.play().then(() => { vid.muted = false; }).catch(() => {
          vid.muted = true;
          vid.play().catch(() => {});
        });
        n.querySelector('.sh-progress i').style.width = '0%';
      } else {
        vid.pause();
        try { vid.currentTime = 0; } catch (_) {}
      }
    });
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting && en.intersectionRatio > 0.55) activate(en.target);
    });
  }, { root: feed, threshold: [0.55] });
  shorts.forEach((n) => io.observe(n));

  shorts.forEach((node) => {
    const vid = node.querySelector('video');
    const pauseIc = node.querySelector('.sh-pause');
    const pbar = node.querySelector('.sh-progress i');
    let tapT = null, tapLast = 0;

    node.addEventListener('click', (e) => {
      if (e.target.closest('.sh-rail') || e.target.closest('.shorts-top')) return;
      const now = Date.now();
      if (now - tapLast < 280) { clearTimeout(tapT); tapLast = 0; return; }
      tapLast = now;
      tapT = setTimeout(() => {
        if (vid.paused) { vid.play().catch(() => {}); pauseIc.classList.remove('show'); }
        else { vid.pause(); pauseIc.classList.add('show'); }
      }, 280);
    });

    vid.addEventListener('timeupdate', () => {
      pbar.style.width = vid.duration ? (vid.currentTime / vid.duration) * 100 + '%' : '0%';
    });

    // кнопки рейла действуют на своё видео (без перерисовки — видео не прерывается)
    node.querySelectorAll('.sh-rail button').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = node.dataset.id;
        const act = btn.dataset.act;
        if (act === 'sh-like') {
          await toggleLike(id);
          const vv = getVideo(id);
          btn.classList.toggle('on', vv.liked === 1);
          btn.querySelector('svg').classList.toggle('icon--fill', vv.liked === 1);
          btn.querySelector('.cnt').textContent = vv.likes > 0 ? fmtCount(vv.likes) : '';
          const dis = node.querySelector('[data-act="sh-dislike"]');
          dis.classList.toggle('on', vv.liked === -1);
          dis.querySelector('svg').classList.toggle('icon--fill', vv.liked === -1);
        } else if (act === 'sh-dislike') {
          await toggleDislike(id);
          const vv = getVideo(id);
          btn.classList.toggle('on', vv.liked === -1);
          btn.querySelector('svg').classList.toggle('icon--fill', vv.liked === -1);
          const lik = node.querySelector('[data-act="sh-like"]');
          lik.classList.toggle('on', vv.liked === 1);
          lik.querySelector('svg').classList.toggle('icon--fill', vv.liked === 1);
          lik.querySelector('.cnt').textContent = vv.likes > 0 ? fmtCount(vv.likes) : '';
        } else if (act === 'sh-comments') openShortsComments(id);
        else if (act === 'sh-share') shareVideo(id);
        else if (act === 'sh-more') videoMenu(id);
      });
    });
  });

  // первый тап по документу включает звук
  const unmute = () => {
    shorts.forEach((n) => { n.querySelector('video').muted = false; });
    document.removeEventListener('pointerdown', unmute);
  };
  document.addEventListener('pointerdown', unmute);

  cleanups.push(() => {
    io.disconnect();
    document.removeEventListener('pointerdown', unmute);
    shorts.forEach((n) => { const vid = n.querySelector('video'); vid.pause(); });
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
  view.innerHTML = `<div class="search-hint" id="search-body"></div>`;
  const inp = $('#search-input');
  renderSearchBody('');
  let deb = null;
  inp.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => renderSearchBody(inp.value), 160);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = inp.value.trim();
      if (q) {
        DB.kvGet('recent', []).then((r) => {
          const list = [q, ...r.filter((x) => x !== q)].slice(0, 8);
          return DB.kvSet('recent', list);
        });
        inp.blur();
      }
      renderSearchBody(q);
    }
  });
  setTimeout(() => inp.focus(), 120);
}

async function renderSearchBody(q) {
  const body = $('#search-body');
  if (!body) return;
  q = (q || '').trim();
  if (!q) {
    const recent = await DB.kvGet('recent', []);
    body.innerHTML = recent.length
      ? recent.map((r) => `
          <button class="hint-row" data-act="search-run" data-q="${esc(r)}">
            ${icon('history')}<span>${esc(r)}</span>
          </button>`).join('') +
        `<button class="hint-row" id="clear-recent" style="color:var(--text-2)">${icon('trash')}<span>Очистить историю поиска</span></button>`
      : `<p style="padding:16px;color:var(--text-2);font-size:13.5px">Ищите по названиям и описаниям ваших видео</p>`;
    const cr = $('#clear-recent');
    if (cr) cr.addEventListener('click', async () => {
      await DB.kvSet('recent', []);
      renderSearchBody('');
    });
    return;
  }
  const ql = q.toLowerCase();
  const res = S.videos.filter((v) =>
    (v.title || '').toLowerCase().includes(ql) ||
    (v.description || '').toLowerCase().includes(ql) ||
    (v.channelName || '').toLowerCase().includes(ql));
  body.innerHTML = res.length
    ? res.map(compactCardHTML).join('')
    : emptyHTML('search', 'Ничего не найдено', 'Попробуйте другой запрос — поиск работает только по вашим видео.');
}

function runSearch(q) {
  const inp = $('#search-input');
  if (inp) { inp.value = q; renderSearchBody(q); }
}

/* ============================== канал / списки ============================== */

async function viewChannel(view, nameRaw) {
  const name = decodeURIComponent(nameRaw || '');
  const mine = S.videos.filter((v) => v.channelName === name);
  const shortsOnly = mine.filter(isShort);
  const subOn = S.settings.subs[name] !== false;
  const tab = S.channelTab || 'videos';

  view.innerHTML = `
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
        ? (mine.length ? feedHTML(mine.slice().sort((a, b) => b.createdAt - a.createdAt))
          : emptyHTML('myvids', 'Нет видео', 'На этом канале пока нет видео.'))
        : (shortsOnly.length ? feedHTML(shortsOnly) : emptyHTML('shorts', 'Нет Shorts', 'Вертикальные видео канала появятся здесь.'))}
    </div>`;

  $$('[data-ctab]', view).forEach((b) => b.addEventListener('click', () => {
    S.channelTab = b.dataset.ctab;
    render();
  }));
}

async function viewHistory(view) {
  const hs = await DB.listHistory();
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

async function viewMyVideos(view) {
  if (!S.videos.length) {
    view.innerHTML = emptyHTML(
      'myvids',
      'Нет видео',
      'Нажмите кнопку загрузки, чтобы добавить первое видео.',
      `<button class="btn-primary" data-act="upload">${icon('plus')}Загрузить видео</button>`
    );
    return;
  }
  const list = S.videos.slice().sort((a, b) => b.createdAt - a.createdAt);
  view.innerHTML = `
    <div class="section-head">Ваши видео • ${list.length}</div>
    ${list.map(compactCardHTML).join('')}
    <div style="padding:16px">
      <button class="btn-primary" data-act="upload">${icon('plus')}Загрузить ещё</button>
    </div>`;
}

async function viewWatchLater(view) {
  const list = S.videos.filter((v) => v.saved);
  view.innerHTML = list.length
    ? `<div class="section-head">Смотреть позже • ${list.length}</div>` + list.map(compactCardHTML).join('')
    : emptyHTML('clock', 'Список пуст', 'Сохраняйте видео, чтобы посмотреть их позже.');
}

async function viewSettings(view) {
  const t = S.settings.theme;
  view.innerHTML = `
    <div class="group-title">Внешний вид</div>
    <div class="set-row">
      ${icon('palette')}
      <div class="sr-label"><b>Тема</b><span>Светлая, тёмная или как в системе</span></div>
    </div>
    <div class="chips" style="padding-top:0">
      <button class="chip ${t === 'light' ? 'on' : ''}" data-act="theme" data-theme-v="light">Светлая</button>
      <button class="chip ${t === 'dark' ? 'on' : ''}" data-act="theme" data-theme-v="dark">Тёмная</button>
      <button class="chip ${t === 'system' ? 'on' : ''}" data-act="theme" data-theme-v="system">Системная</button>
    </div>

    <div class="group-title">Воспроизведение</div>
    <div class="set-row" data-act="toggle-autoplay">
      ${icon('play', 'icon--fill')}
      <div class="sr-label"><b>Автовоспроизведение</b><span>Следующее видео из рекомендаций после окончания</span></div>
      <div class="switch ${S.settings.autoplayNext ? 'on' : ''}"></div>
    </div>

    <div class="group-title">Канал</div>
    <button class="list-row" data-act="edit-channel">
      ${icon('edit')}<span class="lr-label">Название канала</span>
      <span class="lr-value">${esc(S.settings.channelName)}</span>
      ${icon('chev-r', 'lr-chev')}
    </button>

    <div class="group-title">Данные</div>
    <button class="list-row" data-act="clear-history">
      ${icon('history')}<span class="lr-label">Очистить историю просмотров</span>${icon('chev-r', 'lr-chev')}
    </button>
    <button class="list-row danger" data-act="wipe-all">
      ${icon('trash')}<span class="lr-label">Удалить все видео и данные</span>${icon('chev-r', 'lr-chev')}
    </button>

    <div class="about-note">
      ${icon('eye')}
      <div><b style="color:var(--text)">Всё локально.</b> Видео, комментарии и история хранятся только на этом устройстве (IndexedDB) и никогда не покидают его. Приложение работает без интернета.</div>
    </div>`;
}

/* ============================== загрузка видео ============================== */

function openUpload() {
  const root = document.createElement('div');
  root.className = 'upload-page';
  root.innerHTML = `
    <div class="up-bar">
      <button class="icon-btn" id="up-close">${icon('back')}</button>
      <h1>Добавить видео</h1>
    </div>
    <div class="up-body" id="up-body"></div>
    <div class="up-foot" id="up-foot" hidden></div>`;
  document.body.appendChild(root);

  const body = $('#up-body', root);
  const foot = $('#up-foot', root);
  let picked = null;      // {file, meta}
  let objectUrl = null;

  $('#up-close', root).addEventListener('click', () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    root.remove();
  });

  function stepPick() {
    foot.hidden = true;
    body.innerHTML = `
      <div class="up-pick" id="up-pick">
        ${icon('folder-up')}
        <b>Выберите видео на телефоне</b>
        <span>Файл останется на устройстве: ничего не загружается в интернет.</span>
        <button class="btn-blue" id="up-choose">Выбрать файл</button>
      </div>
      <input type="file" id="up-file" accept="video/*" hidden>`;
    $('#up-choose', body).addEventListener('click', () => $('#up-file', body).click());
    $('#up-file', body).addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      body.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;color:var(--text-2);font-size:14px">
          ${icon('refresh')} Обрабатываем видео...
        </div>`;
      try {
        const meta = await extractMeta(file);
        picked = { file, meta };
        stepForm();
      } catch (err) {
        toast('Не удалось прочитать видеофайл');
        stepPick();
      }
    });
  }

  function stepForm() {
    const { file, meta } = picked;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    const defTitle = (file.name || 'Видео').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Без названия';

    body.innerHTML = `
      <div class="up-preview">
        <video src="${objectUrl}" controls playsinline preload="metadata"></video>
        <div class="up-file-info">
          ${icon('myvids')}
          <span>${esc(file.name)} • ${fmtDur(meta.duration)} • ${(file.size / 1048576).toFixed(1)} МБ</span>
        </div>
      </div>
      <div class="up-fields">
        <div>
          <label for="up-title">Название</label>
          <input id="up-title" value="${esc(defTitle)}" maxlength="120" placeholder="Назовите как угодно">
        </div>
        <div>
          <label for="up-desc">Описание</label>
          <textarea id="up-desc" placeholder="Добавьте описание..."></textarea>
        </div>
      </div>
      <div class="up-progress" id="up-prog" hidden><i></i></div>`;

    foot.hidden = false;
    foot.innerHTML = `
      <button class="btn-gray" id="up-cancel">Назад</button>
      <button class="btn-blue" id="up-publish">Опубликовать</button>`;

    $('#up-cancel', foot).addEventListener('click', stepPick);
    $('#up-publish', foot).addEventListener('click', publish);
  }

  async function publish() {
    const title = $('#up-title', body).value.trim();
    if (!title) { toast('Введите название видео'); $('#up-title', body).focus(); return; }
    const description = $('#up-desc', body).value.trim();

    const prog = $('#up-prog', body);
    prog.hidden = false;
    const bar = prog.querySelector('i');
    bar.style.width = '30%';

    const { file, meta } = picked;
    const video = {
      id: 'v' + uid(),
      title,
      description,
      channelName: S.settings.channelName,
      createdAt: Date.now(),
      views: 0,
      likes: 0,
      dislikes: 0,
      liked: 0,
      saved: false,
      duration: meta.duration,
      w: meta.w,
      h: meta.h,
      thumb: meta.thumb,
      file,
      fileName: file.name || (title + '.mp4'),
      mime: file.type || 'video/mp4'
    };

    bar.style.width = '70%';
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
    await DB.putVideo(video);
    await reloadVideos();
    bar.style.width = '100%';

    body.innerHTML = `
      <div class="up-done">
        ${icon('check')}
        <h2>Видео сохранено</h2>
        <p>«${esc(title)}» доступно на этом устройстве и появится в рекомендациях.</p>
        <div class="btns">
          <button class="btn-gray" id="done-home">На главную</button>
          <button class="btn-blue" id="done-watch">Смотреть</button>
        </div>
      </div>`;
    foot.hidden = true;

    $('#done-watch', body).addEventListener('click', () => {
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      root.remove();
      location.hash = '#/watch/' + video.id;
    });
    $('#done-home', body).addEventListener('click', () => {
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      root.remove();
      location.hash = '#/home';
      render();
    });
  }

  stepPick();
}

function once(ev, name, timeout = 6000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, timeout);
    const ok = () => { cleanup(); res(); };
    const err = () => { cleanup(); rej(new Error('error')); };
    function cleanup() {
      clearTimeout(to);
      ev.removeEventListener(name, ok);
      ev.removeEventListener('error', err);
    }
    ev.addEventListener(name, ok, { once: true });
    ev.addEventListener('error', err, { once: true });
  });
}

async function extractMeta(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  try {
    await once(v, 'loadeddata', 9000);
    const duration = isFinite(v.duration) ? v.duration : 0;
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    try {
      v.currentTime = Math.min(Math.max(0.05, duration * 0.25), Math.max(0.05, duration - 0.05));
      await once(v, 'seeked', 5000);
    } catch (_) {}
    const c = document.createElement('canvas');
    const scale = Math.min(1, 640 / (v.videoWidth || 640));
    c.width = Math.max(2, Math.round((v.videoWidth || 640) * scale));
    c.height = Math.max(2, Math.round((v.videoHeight || 360) * scale));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const thumb = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
    return { duration, w, h, thumb };
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute('src');
  }
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

function render() {
  runCleanups();
  const [name, arg] = parseHash();
  if (name !== 'watch') S._watchVisit = null;
  const view = $('#view');
  view.scrollTop = 0;
  view.innerHTML = '';

  document.body.dataset.nav = name === 'watch' ? 'hidden' : '';
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
    case 'watch':
      top.innerHTML = '';
      viewWatch(view, arg);
      break;
    case 'search':
      top.innerHTML = topSearchHTML();
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
  applyTheme();
  await reloadVideos();

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/home';
  render();

  if ('serviceWorker' in navigator && navigator.serviceWorker) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
