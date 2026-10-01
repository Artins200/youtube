/* AndroidBridge виден фреймам WebView, поэтому КАЖДЫЙ нативный метод требует
   случайный токен. Он передаётся Java только главной доверенной странице и
   хранится в замыкании; iframe YouTube не может прочитать его из parent. */
'use strict';
(() => {
  const pending = new Map();
  window.nativeJsonReply = (id, ok, text) => {
    const task = pending.get(id);
    if (!task) return;
    task.cleanup();
    if (!ok) { task.reject(new Error(text || 'Ошибка сетевого запроса.')); return; }
    try { task.resolve(JSON.parse(text)); }
    catch (_) { task.reject(new Error('Сервер вернул неверный JSON.')); }
  };
  window.attachNative = (secret) => {
    if (window.NativeApp || typeof secret !== 'string' || secret.length < 40 || !window.AndroidBridge) return;
    const bridge = window.AndroidBridge;
    const adapter = {
      setBars: (dark) => bridge.setBars(secret, !!dark),
      setNetwork: (offline, instance, relayOnly) => bridge.setNetwork(secret, !!offline, instance || '', !!relayOnly),
      beginExport: (mode, name, mime) => bridge.beginExport(secret, mode, name, mime),
      appendExport: (chunk) => bridge.appendExport(secret, chunk),
      finishExport: () => bridge.finishExport(secret),
      abortExport: () => bridge.abortExport(secret),
      shareLink: (url, title) => bridge.shareLink(secret, url, title || ''),
      openExternal: (url) => bridge.openExternal(secret, url),
      requestJson: (url, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        const cancel = () => {
          bridge.cancelJson(secret, id);
          cleanup(); reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(cancel, 19000);
        function cleanup() {
          clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(id);
        }
        pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener('abort', cancel, { once: true });
        bridge.requestJson(secret, id, url);
      })
    };
    Object.defineProperty(window, 'NativeApp', { value: Object.freeze(adapter), configurable: false });
    window.androidNetworkChanged?.(bridge.networkAvailable(secret));
    window.dispatchEvent(new Event('native-ready'));
    // Не оставляем способ повторно передать другой токен.
    delete window.attachNative;
  };
})();
