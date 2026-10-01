/* Регрессии в настоящем Chromium. Сеть YouTube замокана, это НЕ проверка
   доступности YouTube/РКН. Маленькие цветные клипы — только тестовые fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.join(root, 'tools/package.json'));
const { chromium } = requireTools('playwright');
const options = process.env.CHROMIUM_EXECUTABLE ? {
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--use-angle=swiftshader']
} : {};
const browser = await chromium.launch({ ...options, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [], remoteRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => { if (request.url().startsWith('https:')) remoteRequests.push(request.url()); });
const artifacts = process.env.TEST_ARTIFACTS_DIR || path.join(root, 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const base = process.env.TEST_URL || 'http://localhost:8080';
const fixture = (name) => path.join(root, 'tests/fixtures', name);
const ready = () => page.waitForFunction(() => typeof S !== 'undefined' && S.booted);
const route = async (hash) => { await page.evaluate((value) => { location.hash = value; }, hash); };
const screenshot = (name) => page.screenshot({ path: path.join(artifacts, name + '.png') });
function passed(text) { console.log('✓ ' + text); }
async function choose(type, files) {
  await page.locator('.nav-create').click();
  await page.locator('#sheet').getByRole('button', { name: type === 'short' ? 'Добавить Shorts' : 'Добавить видео', exact: true }).click();
  await page.locator('#up-file').setInputFiles(files);
  await page.waitForFunction((count) => document.querySelectorAll('.up-entry').length === count, files.length, { timeout: 45000 });
}
async function publish() {
  await page.locator('#up-publish').evaluate((button) => { button.click(); button.click(); });
  await page.waitForSelector('#done-more', { timeout: 20000 });
}
try {
  await page.goto(base); await ready();
  assert.equal(await page.locator('.vcard').count(), 0);
  assert.equal(remoteRequests.length, 0);
  await route('#/watch/yt:bad');
  await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('Некорректная ссылка'));
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(remoteRequests.length, 0);
  await route('#/home');
  await page.waitForSelector('.source-strip');

  await choose('short', [fixture('short-blue.webm'), fixture('short-red.webm'), fixture('short-green.webm')]);
  for (let i = 0; i < 3; i++) await page.locator('#up-title-' + i).fill('TestShort' + (i + 1));
  await publish();
  assert.equal(await page.evaluate(() => S.videos.length), 3);
  assert.equal(await page.evaluate(() => S.videos.filter(isShort).length), 3);
  passed('Пакетный импорт 3 Shorts; двойное нажатие не создаёт дубликаты');
  await page.locator('#done-more').click();
  await page.locator('#up-file').setInputFiles(fixture('short-blue.webm'));
  await page.waitForSelector('.up-entry'); await page.locator('#up-title-0').fill('TestShort4');
  await publish(); await page.locator('#up-close').click();
  assert.equal(await page.evaluate(() => S.videos.filter(isShort).length), 4);
  assert.equal(await page.locator('.vcard').count(), 0);
  assert.equal(await page.locator('.shorts-tile').count(), 4);
  passed('Повторный импорт четвёртого Short и полка без обычных карточек');

  await page.locator('[data-tab="shorts"]').click();
  await page.waitForSelector('.short'); await page.waitForFunction(() => S.shortActive !== null);
  const geometry = await page.evaluate(() => {
    const feed = document.querySelector('#shorts-feed');
    return { height: feed.clientHeight, scroll: feed.scrollHeight, count: feed.children.length,
      next: feed.children[1].dataset.id, first: S.shortActive.id };
  });
  assert.ok(geometry.height > 500);
  assert.equal(geometry.count, 4);
  assert.ok(Math.abs(geometry.scroll - geometry.height * 4) < 4);
  await page.locator('#shorts-feed').evaluate((feed) => feed.scrollTo(0, feed.clientHeight));
  await page.waitForFunction((id) => S.shortActive?.id === id, geometry.next);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.short video')].filter((video) => !video.paused).length), 1);
  await screenshot('shorts');
  passed('Свайп на второй Short; играет только активный ролик, высота ленты не растягивается');

  await page.locator('[data-tab="home"]').click();
  await choose('video', [fixture('normal.webm')]);
  await page.locator('#up-title-0').fill('OnlyRegularVideo'); await publish(); await page.locator('#up-close').click();
  assert.equal(await page.locator('.vcard').count(), 1);
  assert.equal(await page.locator('.shorts-tile').count(), 4);
  assert.match(await page.locator('.vcard').innerText(), /OnlyRegularVideo/);
  await screenshot('home');
  await route('#/channel/' + encodeURIComponent(await page.evaluate(() => S.settings.channelName)));
  await page.waitForSelector('[data-ctab="shorts"]');
  assert.equal(await page.locator('.vcard').count(), 1);
  await page.locator('[data-ctab="shorts"]').click();
  assert.equal(await page.locator('.sg-card').count(), 4);
  assert.equal(await page.locator('.vcard').count(), 0);
  passed('Главная и вкладки канала отделяют видео от Shorts');

  await route('#/search'); await page.waitForSelector('#search-input');
  await page.locator('#search-input').fill('TestShort'); await page.locator('#search-input').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.sg-card').length === 4);
  assert.equal(await page.locator('.ccard:not(.short-ccard)').count(), 0);
  passed('Локальный поиск показывает Shorts отдельной вертикальной сеткой');

  await route('#/settings'); await page.waitForSelector('[data-act="toggle-offline"]');
  await page.locator('[data-act="toggle-offline"]').click();
  await page.waitForFunction(() => document.querySelector('[data-act="toggle-offline"]').getAttribute('aria-checked') === 'true');
  assert.equal(await page.locator('#connection-banner').isVisible(), true);
  await page.reload(); await ready();
  assert.equal(await page.evaluate(() => S.settings.offlineMode), true);
  assert.equal(await page.evaluate(() => S.videos.length), 5);
  assert.equal(remoteRequests.length, 0);
  passed('Офлайн-настройка и 5 файлов сохраняются после перезагрузки');

  // Ошибка квоты не прячет форму, не оставляет кнопку заблокированной и допускает повтор.
  await page.evaluate(() => {
    window.savedPutVideoForTest = DB.putVideo;
    DB.putVideo = async (video) => {
      if (video.title === 'NoSpaceTest') throw new DOMException('Full', 'QuotaExceededError');
      return window.savedPutVideoForTest(video);
    };
  });
  await choose('video', [fixture('normal.webm')]);
  await page.locator('#up-title-0').fill('NoSpaceTest');
  await page.locator('#up-publish').click();
  await page.waitForFunction(() => document.querySelector('.up-entry-error')?.textContent.includes('Не удалось сохранить'));
  await page.waitForFunction(() => document.querySelector('#up-publish')?.disabled === false);
  assert.equal(await page.evaluate(() => S.videos.length), 5);
  await page.evaluate(() => { DB.putVideo = window.savedPutVideoForTest; delete window.savedPutVideoForTest; });
  await publish();
  assert.equal(await page.evaluate(() => S.videos.length), 6);
  await page.locator('#up-close').click();
  await page.evaluate(async () => { const test = S.videos.find((video) => video.title === 'NoSpaceTest'); await DB.delVideo(test.id); await reloadVideos(); render(); });
  passed('При нехватке места импорт можно повторить; уже сохранённые файлы не дублируются');

  await page.locator('[data-act="toggle-offline"]').click();
  await page.waitForFunction(() => S.settings.offlineMode === false);
  await page.locator('[data-provider="invidious"]').click();
  await page.waitForSelector('[data-act="edit-instance"]');
  await page.locator('[data-act="edit-instance"]').click();
  await page.locator('#f-url').fill('https://video.example.test'); await page.locator('#sheet-form .sb-ok').click();
  await page.waitForFunction(() => S.settings.invidiousInstance === 'https://video.example.test');

  const regular = { videoId: 'abcdefghijk', type: 'video', title: 'RemoteRegular', author: 'RemoteAuthor', viewCount: 123,
    published: 1750000000, lengthSeconds: 90, videoThumbnails: [{ quality: 'medium', url: 'https://video.example.test/thumb.png' }] };
  const short = { ...regular, videoId: 'ABCDEFGHIJK', type: 'video', isShort: true, title: 'RemoteShort', lengthSeconds: 20 };
  await page.route('https://video.example.test/**', async (request) => {
    const url = new URL(request.request().url());
    const headers = { 'access-control-allow-origin': '*' };
    if (url.pathname === '/thumb.png') return request.fulfill({ contentType: 'image/png', headers, body: fs.readFileSync(path.join(root, 'app/icons/icon-192.png')) });
    if (url.pathname.startsWith('/embed/')) return request.fulfill({ contentType: 'text/html', headers, body: '<!doctype html><title>Mock player</title>Test player' });
    const data = url.pathname.includes('/videos/') ? { ...(url.pathname.endsWith('ABCDEFGHIJK') ? short : regular), formatStreams: [], recommendedVideos: [] } : [regular, short];
    return request.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });
  });
  await route('#/home'); await page.waitForSelector('.source-button[data-source="youtube"]');
  await page.locator('.source-button[data-source="youtube"]').click();
  await page.waitForFunction(() => document.querySelector('.vcard')?.textContent.includes('RemoteRegular'));
  assert.equal(await page.locator('.vcard').count(), 1);
  assert.equal(await page.locator('.shorts-tile').count(), 1);
  assert.ok(remoteRequests.some((url) => new URL(url).pathname === '/api/v1/trending'));
  await page.locator('#topbar [data-act="open-search"]').click();
  await page.locator('#search-input').fill('online query'); await page.locator('#search-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ccard')?.textContent.includes('RemoteRegular'));
  assert.equal(await page.locator('.sg-card').count(), 1);
  assert.ok(remoteRequests.some((url) => new URL(url).searchParams.get('q') === 'online query'));
  passed('Онлайн API-адаптер: поиск, лента и Shorts (mock, не живой сервер)');

  await page.locator('.ccard .cthumb').click();
  await page.waitForSelector('#online-player iframe');
  const playerURL = new URL(await page.locator('#online-player iframe').getAttribute('src'));
  assert.equal(playerURL.origin, 'https://video.example.test');
  assert.equal(playerURL.searchParams.get('local'), 'true');
  assert.equal(playerURL.searchParams.has('key'), false);
  assert.equal(remoteRequests.some((url) => new URL(url).hostname.endsWith('.googlevideo.com')), false);
  passed('Встроенный плеер использует выбранный сервер с local=true, не отправляет API-ключ в iframe');

  await route('#/settings'); await page.waitForSelector('[data-act="toggle-offline"]');
  await page.locator('[data-act="toggle-offline"]').click();
  await page.waitForFunction(() => effectiveOffline());
  const beforeOffline = remoteRequests.length;
  await route('#/home'); await page.waitForSelector('.shorts-shelf');
  await page.reload(); await ready();
  assert.equal(await page.locator('.vcard').count(), 1);
  assert.equal(await page.locator('.shorts-tile').count(), 4);
  await page.waitForTimeout(400);
  assert.equal(remoteRequests.length, beforeOffline);
  assert.equal(await page.evaluate(() => S.settings.homeSource), 'youtube');
  passed('Сохранённый онлайн-источник в офлайне показывает локальные файлы без внешних запросов');

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((resolve) => {
    if (navigator.serviceWorker.controller) resolve();
    else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  })));
  await context.setOffline(true);
  await page.reload(); await ready();
  await route('#/downloads'); await page.waitForSelector('.ccard');
  await page.locator('.ccard .cthumb').first().click(); await page.waitForSelector('#wvideo');
  await page.waitForFunction(() => document.querySelector('#wvideo')?.currentTime > 0, null, { timeout: 10000 });
  passed('После полного отключения сети PWA запускается из кэша и проигрывает локальный файл');

  await route('#/settings'); await page.waitForSelector('[data-act="toggle-offline"]');
  await page.locator('[data-act="toggle-offline"]').click();
  await page.waitForFunction(() => !S.settings.offlineMode && effectiveOffline() && document.querySelector('[data-act="toggle-offline"]').getAttribute('aria-checked') === 'false');
  assert.match(await page.locator('#connection-banner').innerText(), /Нет подключения/);
  await context.setOffline(false);
  await page.waitForFunction(() => !effectiveOffline() && document.querySelector('#connection-banner').hidden);
  passed('Автоофлайн реагирует на потерю и восстановление соединения');
  await screenshot('settings');

  await route('#/home'); await page.waitForSelector('.source-button[data-source="local"]');
  await page.locator('.source-button[data-source="local"]').click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => [...document.querySelectorAll('#view img')].every((image) => image.complete && image.naturalWidth > 0));
  await screenshot('desktop');
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  await page.locator('#desktop-query').fill('OnlyRegularVideo'); await page.locator('#desktop-query').press('Enter');
  await page.waitForFunction(() => document.querySelector('.ccard')?.textContent.includes('OnlyRegularVideo'));
  assert.equal(await page.locator('.ccard').count(), 1);
  assert.deepEqual(errors, []);
  passed('Мобильный и десктопный интерфейсы: без ошибок JS и горизонтального переполнения');
  console.log('\nВсе браузерные проверки прошли. Снимки: ' + artifacts);
} finally { await browser.close(); }
