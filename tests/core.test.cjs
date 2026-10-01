const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const requireTools = createRequire(require('node:path').resolve(__dirname, '../tools/package.json'));
const { indexedDB } = requireTools('fake-indexeddb');
const Media = require('../app/media.js');

test('Типы: несколько Shorts, квадратный формат, до 3 минут и ручной выбор', () => {
  const videos = [
    { id: 'one', w: 1080, h: 1920, duration: 59 },
    { id: 'two', w: 720, h: 1280, duration: 179 },
    { id: 'square', w: 720, h: 720, duration: 180 },
    { id: 'long', w: 1080, h: 1920, duration: 181 },
    { id: 'wide', w: 1920, h: 1080, duration: 10 },
    { id: 'explicit', contentType: 'video', w: 720, h: 1280, duration: 10 },
    { id: 'manual', contentType: 'short', w: 1920, h: 1080, duration: 30 }
  ];
  assert.deepEqual(videos.filter(Media.isShort).map((v) => v.id), ['one', 'two', 'square', 'manual']);
  assert.deepEqual(videos.filter((v) => !Media.isShort(v)).map((v) => v.id), ['long', 'wide', 'explicit']);
  assert.equal(Media.isShort({ w: 0, h: 0, duration: 1 }), false);
  assert.equal(Media.inferType({ w: 720, h: 1280, duration: 180 }), 'short');
});

test('Реальные ссылки YouTube/Shorts: валидация ID и защита от похожих доменов', () => {
  for (const url of ['https://youtu.be/abcdefghijk?t=2', 'https://www.youtube.com/watch?v=abcdefghijk',
    'https://m.youtube.com/embed/abcdefghijk', 'abcdefghijk']) {
    assert.equal(Media.parseYouTubeLink(url)?.videoId, 'abcdefghijk');
  }
  assert.equal(Media.parseYouTubeLink('https://youtube.com/shorts/abcdefghijk').short, true);
  for (const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk', 'javascript:alert(1)',
    'https://evil@youtube.com/watch?v=abcdefghijk', 'https://youtu.be/too-short',
    'https://youtube.com/playlist?list=abcdefghijk', 'https://youtube.com:8443/watch?v=abcdefghijk']) {
    assert.equal(Media.parseYouTubeLink(url), null, url);
  }
  assert.equal(Media.httpsURL('http://unsafe.test'), '');
  assert.equal(Media.httpsURL('//images.example.test/thumb.jpg', 'https://video.example.test'), 'https://images.example.test/thumb.jpg');
  assert.equal(Media.instanceURL('https://video.example.test/invidious/'), 'https://video.example.test/invidious');
  for (const url of ['http://video.example.test', 'https://user:password@video.example.test', 'https://video.example.test?key=secret', 'https://localhost:8080', 'https://127.0.0.1']) {
    assert.throws(() => Media.instanceURL(url));
  }
});

function service(fetch) {
  const context = vm.createContext({ Media, window: {}, location: { origin: 'https://app.example.test' },
    URL, fetch, AbortController, DOMException, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../app/youtube.js'), 'utf8'), context);
  return vm.runInContext('YouTube', context);
}
const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

test('Официальный источник: без ключа открывает oEmbed, не подставляет фальшивый API-ключ', async () => {
  const calls = [];
  const youtube = service(async (url) => { calls.push(new URL(url)); return json({ title: 'Test', author_name: 'Author', thumbnail_url: 'https://i.ytimg.com/thumb.jpg' }); });
  const { item } = await youtube.video('abcdefghijk', undefined, true);
  assert.equal(item.contentType, 'short');
  assert.equal(item.videoId, 'abcdefghijk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'www.youtube.com');
  assert.equal(calls[0].pathname, '/oembed');
  assert.equal(calls[0].searchParams.has('key'), false);
  assert.match(youtube.embedURL('abcdefghijk'), /^https:\/\/www.youtube-nocookie.com\/embed\//);
  await assert.rejects(() => youtube.trending(), /ключ/);
});

test('Официальный поиск получает настоящие endpoint-ы, детали и пагинацию', async () => {
  const calls = [];
  const youtube = service(async (text) => {
    const url = new URL(text); calls.push(url);
    assert.equal(url.searchParams.get('key'), 'unit-test-key');
    if (url.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: 'abcdefghijk' } }], nextPageToken: 'NEXT' });
    return json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Result', channelTitle: 'Channel', publishedAt: '2025-01-01T00:00:00Z' },
      statistics: { viewCount: '42' }, contentDetails: { duration: 'PT1H2M3S' } }] });
  });
  youtube.configure({ apiKey: 'unit-test-key' });
  const result = await youtube.search('русский запрос');
  assert.equal(result.items[0].duration, 3723);
  assert.equal(result.items[0].views, 42);
  assert.equal(result.items[0].contentType, 'video');
  assert.equal(result.nextPage, 'NEXT');
  assert.deepEqual(calls.map((url) => url.pathname), ['/youtube/v3/search', '/youtube/v3/videos']);
  assert.equal(calls[0].searchParams.get('q'), 'русский запрос');
  assert.equal(youtube.durationISO('PT3M'), 180);
});

test('Invidious: доверенный адрес, local=true и поток через него, не напрямую Google Video', async () => {
  const calls = [];
  const youtube = service(async (url) => {
    calls.push(new URL(url));
    return json({ videoId: 'abcdefghijk', title: 'Test', author: 'Author', lengthSeconds: 30, type: 'video', isShort: true,
      videoThumbnails: [{ quality: 'medium', url: '/thumbnail.jpg' }],
      formatStreams: [{ type: 'video/mp4; codecs="avc1, mp4a"', qualityLabel: '360p', url: 'https://r1.googlevideo.com/videoplayback?id=123&itag=18' }] });
  });
  youtube.configure({ provider: 'invidious', instance: 'https://video.example.test', proxyPlayback: true });
  const result = await youtube.video('abcdefghijk');
  assert.equal(result.item.contentType, 'short');
  assert.equal(youtube.normalizeInvidious({ videoId: 'ABCDEFGHIJK', type: 'shortVideo', lengthSeconds: 600 }).contentType, 'video');
  assert.equal(new URL(result.stream).origin, 'https://video.example.test');
  assert.equal(new URL(result.stream).pathname, '/videoplayback');
  assert.equal(calls[0].searchParams.get('local'), 'true');
  assert.equal(new URL(youtube.embedURL('abcdefghijk')).origin, 'https://video.example.test');
});

test('Ручной офлайн не выполняет даже один сетевой запрос', async () => {
  let calls = 0;
  const youtube = service(async () => { calls++; throw new Error('Must not fetch'); });
  youtube.configure({ apiKey: 'test', offline: true });
  await assert.rejects(() => youtube.video('abcdefghijk'), /отключена/);
  await assert.rejects(() => youtube.search('query'), /Офлайн/);
  await assert.rejects(() => youtube.trending(), /Офлайн/);
  assert.equal(calls, 0);
});

test('Смена режима отменяет выполняющийся онлайн-запрос', async () => {
  const youtube = service((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const pending = youtube.video('abcdefghijk');
  youtube.configure({ offline: true });
  await assert.rejects(() => pending, { name: 'AbortError' });
});

test('IndexedDB: несколько файлов записываются после commit, сохраняются при повторном чтении', async () => {
  const context = vm.createContext({ indexedDB, Date, Math, Blob, console });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../app/db.js'), 'utf8'), context);
  const db = vm.runInContext('DB', context);
  for (let i = 1; i <= 4; i++) await db.putVideo({ id: 'short-' + i, contentType: 'short', createdAt: i, file: new Blob(['file-' + i]) });
  const videos = await db.listVideos();
  assert.equal(videos.length, 4);
  assert.equal(videos[0].id, 'short-4');
  assert.equal(await videos[0].file.text(), 'file-4');
  await db.kvSet('offlineMode', true);
  assert.equal(await db.kvGet('offlineMode', false), true);
  await db.addComment('short-4', 'hello', 'Tester');
  await db.addHistory('short-4');
  await db.delVideo('short-4');
  assert.equal((await db.listVideos()).length, 3);
  assert.equal((await db.listComments('short-4')).length, 0);
  assert.equal((await db.listHistory()).length, 0);
});

test('Все Android JS-методы требуют токен; iframe не получает ключи/экспортер без авторизации', () => {
  const code = fs.readFileSync(require('node:path').join(__dirname, '../android/app/src/main/java/app/ytlocal/player/MainActivity.java'), 'utf8');
  const methods = [...code.matchAll(/@JavascriptInterface\s+public\s+\w+\s+(\w+)\(([^)]*)\)\s*\{([\s\S]*?)(?=\n\s*@JavascriptInterface|\n    \})/g)];
  assert.ok(methods.length >= 10);
  for (const [, name, args, body] of methods) {
    assert.match(args, /^String secret\b/, name);
    assert.match(body, /authorized\(secret\)/, name);
  }
  assert.match(code, /new SecureRandom\(\)/);
  assert.match(code, /EXTRA_ALLOW_MULTIPLE/);
  assert.match(code, /getClipData\(\)/);
  assert.match(code, /setBlockNetworkLoads\(offline\)/);
  assert.match(code, /Direct Video Disabled/);
});
