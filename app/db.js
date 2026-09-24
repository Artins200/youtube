/* ============================================================
   db.js — локальное хранилище IndexedDB.
   Видео-файлы (Blob), превью, комментарии, история и настройки
   хранятся ТОЛЬКО на устройстве и никуда не отправляются.
   ============================================================ */

const DB = (() => {
  const NAME = 'ytlocal';
  const VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('videos')) {
          const st = db.createObjectStore('videos', { keyPath: 'id' });
          st.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('comments')) {
          const st = db.createObjectStore('comments', { keyPath: 'id' });
          st.createIndex('videoId', 'videoId');
        }
        if (!db.objectStoreNames.contains('history')) {
          const st = db.createObjectStore('history', { keyPath: 'id' });
          st.createIndex('at', 'at');
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }

  const rq = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  async function put(store, val) {
    const db = await open();
    return rq(db.transaction(store, 'readwrite').objectStore(store).put(val));
  }

  async function get(store, key) {
    const db = await open();
    return rq(db.transaction(store, 'readonly').objectStore(store).get(key));
  }

  async function del(store, key) {
    const db = await open();
    return rq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
  }

  async function all(store) {
    const db = await open();
    return rq(db.transaction(store, 'readonly').objectStore(store).getAll());
  }

  async function byIndex(store, index, value) {
    const db = await open();
    const st = db.transaction(store, 'readonly').objectStore(store);
    return rq(st.index(index).getAll(value));
  }

  async function clear(store) {
    const db = await open();
    return rq(db.transaction(store, 'readwrite').objectStore(store).clear());
  }

  /* ---- удобное API ---- */

  return {
    open,

    async listVideos() {
      const vs = await all('videos');
      vs.sort((a, b) => b.createdAt - a.createdAt);
      return vs;
    },
    getVideo: (id) => get('videos', id),
    putVideo: (v) => put('videos', v),
    delVideo: async (id) => {
      await del('videos', id);
      const cs = await byIndex('comments', 'videoId', id);
      for (const c of cs) await del('comments', c.id);
      const hs = (await all('history')).filter((h) => h.videoId === id);
      for (const h of hs) await del('history', h.id);
    },

    async addComment(videoId, text, author) {
      const c = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        videoId,
        text,
        author: author || 'Вы',
        at: Date.now()
      };
      await put('comments', c);
      return c;
    },
    async listComments(videoId) {
      const cs = await byIndex('comments', 'videoId', videoId);
      cs.sort((a, b) => b.at - a.at);
      return cs;
    },
    delComment: (id) => del('comments', id),

    async addHistory(videoId) {
      const h = { id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), videoId, at: Date.now() };
      await put('history', h);
      // храним последние 300 записей
      const hs = (await all('history')).sort((a, b) => b.at - a.at);
      for (const old of hs.slice(300)) await del('history', old.id);
    },
    async listHistory() {
      const hs = await all('history');
      hs.sort((a, b) => b.at - a.at);
      return hs;
    },
    clearHistory: () => clear('history'),

    kvGet: async (k, def) => {
      const r = await get('kv', k);
      return r === undefined ? def : r.v;
    },
    kvSet: (k, v) => put('kv', { k, v }),

    async wipeAll() {
      await clear('videos');
      await clear('comments');
      await clear('history');
      const theme = await this.kvGet('theme', 'light');
      const channelName = await this.kvGet('channelName', 'Мой канал');
      const channelColor = await this.kvGet('channelColor', 262);
      await clear('kv');
      await this.kvSet('theme', theme);
      await this.kvSet('channelName', channelName);
      await this.kvSet('channelColor', channelColor);
    }
  };
})();
