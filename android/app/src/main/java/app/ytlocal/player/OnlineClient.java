package app.ytlocal.player;

import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Ограниченный HTTPS-клиент API. Не универсальный прокси и не загрузчик видео. */
final class OnlineClient {
    interface Reply { void receive(String id, boolean ok, String body); }
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private final Reply reply;
    private volatile boolean offline = true;
    private volatile String instance = "";

    private static final class Task {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        void cancel() {
            cancelled = true;
            if (connection != null) connection.disconnect();
        }
    }

    OnlineClient(Reply reply) { this.reply = reply; }

    void configure(boolean offline, String instance) {
        this.offline = offline;
        this.instance = instance == null ? "" : instance.replaceAll("/+$", "");
        cancelAll();
    }

    private boolean allowed(String text) {
        if (offline || text == null || text.length() > 12000) return false;
        try {
            Uri uri = Uri.parse(text);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getFragment() != null) return false;
            String host = uri.getHost();
            String path = uri.getPath();
            if ("www.googleapis.com".equals(host) && uri.getPort() == -1) {
                return "/youtube/v3/search".equals(path) || "/youtube/v3/videos".equals(path);
            }
            if ("www.youtube.com".equals(host) && uri.getPort() == -1) return "/oembed".equals(path);
            if (instance.isEmpty()) return false;
            Uri base = Uri.parse(instance);
            if (!"https".equals(base.getScheme()) || !host.equals(base.getHost())
                    || uri.getPort() != base.getPort() || base.getUserInfo() != null) return false;
            String prefix = (base.getPath() == null ? "" : base.getPath().replaceAll("/+$", "")) + "/api/v1/";
            if (path == null || !path.startsWith(prefix)) return false;
            String endpoint = path.substring(prefix.length());
            return endpoint.matches("(?:search|trending|popular|stats|videos/[a-zA-Z0-9_-]{11})");
        } catch (Exception error) { return false; }
    }

    void request(final String id, final String text) {
        if (id == null || !id.matches("[a-zA-Z0-9_-]{1,80}")) return;
        if (!allowed(text)) { reply.receive(id, false, "Сеть отключена или API-адрес не разрешён."); return; }
        if (tasks.size() >= 8 || tasks.containsKey(id)) { reply.receive(id, false, "Дождитесь завершения предыдущих запросов."); return; }
        final Task task = new Task();
        tasks.put(id, task);
        executor.execute(new Runnable() {
            @Override public void run() {
                try {
                    if (task.cancelled || !allowed(text)) return;
                    URL url = new URL(text);
                    int redirects = 0;
                    while (true) {
                        if (task.cancelled || !allowed(url.toString())) return;
                        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                        task.connection = connection;
                        connection.setConnectTimeout(8000);
                        connection.setReadTimeout(15000);
                        connection.setInstanceFollowRedirects(false);
                        connection.setRequestProperty("Accept", "application/json");
                        connection.setRequestProperty("User-Agent", "YouTubeLocal/1.1 Android");
                        int status = connection.getResponseCode();
                        if (status >= 300 && status < 400) {
                            String location = connection.getHeaderField("Location");
                            connection.disconnect();
                            if (location == null || ++redirects > 3) throw new Exception("redirect");
                            URL next = new URL(url, location);
                            // Не передаём API-ключи и запросы иному оператору через redirect.
                            if (!next.getHost().equals(url.getHost()) || !allowed(next.toString())) throw new Exception("redirect");
                            url = next;
                            continue;
                        }
                        if (status < 200 || status >= 300) {
                            String message = status == 403
                                    ? "API запретил доступ (HTTP 403). Проверьте ключ, квоту и ограничения YouTube Data API v3."
                                    : "API вернул HTTP " + status + ". Проверьте источник и доступность видео.";
                            if (!task.cancelled && !offline) reply.receive(id, false, message);
                            return;
                        }
                        if (connection.getContentLength() > MAX_BYTES) throw new Exception("size");
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                        try (InputStream stream = connection.getInputStream()) {
                            byte[] buffer = new byte[8192];
                            int count;
                            while ((count = stream.read(buffer)) != -1) {
                                if (task.cancelled || offline) return;
                                if (bytes.size() + count > MAX_BYTES) throw new Exception("size");
                                bytes.write(buffer, 0, count);
                            }
                        }
                        if (!task.cancelled && !offline) {
                            reply.receive(id, true, new String(bytes.toByteArray(), StandardCharsets.UTF_8));
                        }
                        return;
                    }
                } catch (Exception error) {
                    if (!task.cancelled && !offline) reply.receive(id, false,
                            "Нет ответа от HTTPS-сервера. Проверьте сеть, адрес и доступность источника.");
                } finally {
                    if (task.connection != null) task.connection.disconnect();
                    tasks.remove(id);
                }
            }
        });
    }

    void cancel(String id) {
        Task task = tasks.remove(id);
        if (task != null) task.cancel();
    }
    private void cancelAll() {
        for (Task task : tasks.values()) task.cancel();
        tasks.clear();
    }
    void close() { offline = true; cancelAll(); executor.shutdownNow(); }
}
