package app.ytlocal.player;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import java.util.Collections;

/** Интерфейс и локальные видео работают из APK. Онлайн-фреймы изолированы от NativeBridge токеном. */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String BASE = ORIGIN + "/assets/";
    private static final int PICK_VIDEO = 11;
    private static final int SAVE_VIDEO = 12;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private View fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private boolean darkBars = false;
    private volatile boolean networkOffline = true;
    private volatile boolean relayOnly = false;
    private String bridgeSecret;
    private OnlineClient onlineClient;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;

    // Контент передаётся порциями по 48 КБ: не превращаем большой видеофайл в одну строку.
    private final Object exportLock = new Object();
    private OutputStream exportStream;
    private String exportMode;
    private String exportName;
    private String exportMime;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        byte[] token = new byte[32];
        new SecureRandom().nextBytes(token);
        bridgeSecret = Base64.encodeToString(token, Base64.NO_WRAP);
        networkOffline = getSharedPreferences("network", MODE_PRIVATE).getBoolean("offline", true);
        onlineClient = new OnlineClient(new OnlineClient.Reply() {
            @Override public void receive(final String id, final boolean ok, final String body) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (webView != null && isAppUrl(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) {
                            webView.evaluateJavascript("window.nativeJsonReply && window.nativeJsonReply("
                                    + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(body) + ")", null);
                        }
                    }
                });
            }
        });
        updateBars(false);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // content:// URI системного выбора видео
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setDefaultTextEncodingName("UTF-8");
        settings.setBlockNetworkLoads(networkOffline);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isAppUrl(request.getUrl())) return false;
                if (request.isForMainFrame()) return true; // основной origin никогда не становится внешним
                return networkOffline || !"https".equals(request.getUrl().getScheme());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (isAppUrl(Uri.parse(url))) {
                    view.evaluateJavascript("window.attachNative && window.attachNative("
                            + JSONObject.quote(bridgeSecret) + ")", null);
                    notifyNetwork();
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!isAppUrl(url)) {
                    if (request.isForMainFrame() || networkOffline || !"https".equals(url.getScheme())) {
                        return errorResponse(403, "Forbidden");
                    }
                    String host = url.getHost();
                    if (relayOnly && host != null && (host.equals("googlevideo.com") || host.endsWith(".googlevideo.com"))) {
                        return errorResponse(403, "Direct Video Disabled");
                    }
                    // HTTPS-превью/плеер идут в сеть, но не получают токен нативного интерфейса.
                    return null;
                }
                String path = url.getPath().substring("/assets/".length());
                if (path.isEmpty()) path = "index.html";
                if (path.contains("..") || path.contains("\\") || path.startsWith("/")) {
                    return errorResponse(403, "Forbidden");
                }
                try {
                    InputStream stream = getAssets().open("www/" + path, AssetManager.ACCESS_STREAMING);
                    WebResourceResponse response = new WebResourceResponse(mimeFor(path),
                            isText(path) ? "UTF-8" : null, stream);
                    response.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-store"));
                    return response;
                } catch (IOException missing) {
                    return errorResponse(404, "Not Found");
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    // SAF/системный выбор. Не запрашиваем доступ ко всему хранилищу.
                    Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("video/*");
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    startActivityForResult(pick, PICK_VIDEO);
                } catch (Exception e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор видео", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullScreenView = view;
                fullScreenCallback = callback;
                webView.setVisibility(View.GONE);
                ((FrameLayout) getWindow().getDecorView()).addView(view,
                        new FrameLayout.LayoutParams(-1, -1));
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
            }

            @Override
            public void onHideCustomView() {
                hideFullScreen();
            }
        });

        // HTTPS-origin для IndexedDB; локальные ресурсы всегда берём из APK. Сеть включается настройкой.
        webView.loadUrl(BASE + "index.html");
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (connectivity != null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network network) { notifyNetwork(); }
                @Override public void onLost(Network network) { notifyNetwork(); }
                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) { notifyNetwork(); }
            };
            try { connectivity.registerDefaultNetworkCallback(networkCallback); }
            catch (Exception ignored) { networkCallback = null; }
        }
    }

    private static boolean isAppUrl(Uri uri) {
        return "https".equals(uri.getScheme())
                && "appassets.androidplatform.net".equals(uri.getHost())
                && uri.getPort() == -1
                && uri.getPath() != null && uri.getPath().startsWith("/assets/");
    }

    private static boolean isText(String name) {
        return name.endsWith(".html") || name.endsWith(".js")
                || name.endsWith(".css") || name.endsWith(".webmanifest");
    }

    private static String mimeFor(String name) {
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".txt")) return "text/plain";
        if (name.endsWith(".webmanifest")) return "application/manifest+json";
        return "text/html";
    }

    private static WebResourceResponse errorResponse(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason,
                Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream(new byte[0]));
    }

    private void updateBars(boolean dark) {
        darkBars = dark;
        Window window = getWindow();
        int color = Color.parseColor(dark ? "#0f0f0f" : "#ffffff");
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        if (fullScreenView == null) {
            int flags = dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26 && !dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    private void hideFullScreen() {
        if (fullScreenView == null) return;
        ((FrameLayout) getWindow().getDecorView()).removeView(fullScreenView);
        fullScreenView = null;
        webView.setVisibility(View.VISIBLE);
        WebChromeClient.CustomViewCallback callback = fullScreenCallback;
        fullScreenCallback = null;
        if (callback != null) callback.onCustomViewHidden();
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        updateBars(darkBars);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_VIDEO) {
            if (fileCallback != null) {
                List<Uri> uris = new ArrayList<>();
                if (result == RESULT_OK && data != null) {
                    ClipData clips = data.getClipData();
                    if (clips != null) {
                        for (int i = 0; i < clips.getItemCount(); i++) {
                            Uri uri = clips.getItemAt(i).getUri();
                            if (uri != null && "content".equals(uri.getScheme())) uris.add(uri);
                        }
                    } else if (data.getData() != null && "content".equals(data.getData().getScheme())) {
                        uris.add(data.getData());
                    }
                }
                Uri[] picked = uris.isEmpty() ? null : uris.toArray(new Uri[uris.size()]);
                fileCallback.onReceiveValue(picked);
                fileCallback = null;
            }
        } else if (request == SAVE_VIDEO) {
            if (result != RESULT_OK || data == null || data.getData() == null) {
                discardExport();
                exportReady(false);
                return;
            }
            try {
                OutputStream output = getContentResolver().openOutputStream(data.getData(), "w");
                if (output == null) throw new IOException("No output stream");
                synchronized (exportLock) { exportStream = output; }
                exportReady(true);
            } catch (Exception e) {
                discardExport();
                exportReady(false);
                Toast.makeText(this, "Не удалось сохранить файл", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void exportReady(boolean ready) {
        if (webView != null) {
            webView.evaluateJavascript("window.androidExportReady && window.androidExportReady("
                    + ready + ")", null);
        }
    }

    private void discardExport() {
        synchronized (exportLock) {
            if (exportStream != null) {
                try { exportStream.close(); } catch (IOException ignored) { }
                exportStream = null;
            }
            if ("share".equals(exportMode)) new File(getCacheDir(), "shared-video").delete();
            exportMode = null;
        }
    }

    private static boolean validYouTubeUrl(String text) {
        if (text == null || text.length() > 500) return false;
        Uri uri = Uri.parse(text);
        return "https".equals(uri.getScheme()) && "www.youtube.com".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getUserInfo() == null
                && ("/watch".equals(uri.getPath()) || (uri.getPath() != null && uri.getPath().matches("/shorts/[a-zA-Z0-9_-]{11}")));
    }

    private boolean authorized(String secret) {
        return secret != null && secret.length() == bridgeSecret.length()
                && MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8),
                bridgeSecret.getBytes(StandardCharsets.UTF_8));
    }

    private boolean networkAvailable() {
        if (connectivity == null) return false;
        try {
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception error) { return false; }
    }

    private void notifyNetwork() {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView != null) webView.evaluateJavascript("window.androidNetworkChanged && window.androidNetworkChanged("
                        + networkAvailable() + ")", null);
            }
        });
    }

    private final class NativeBridge {
        @JavascriptInterface
        public boolean networkAvailable(String secret) {
            return authorized(secret) && MainActivity.this.networkAvailable();
        }

        @JavascriptInterface
        public void setNetwork(String secret, final boolean offline, String instance, boolean proxyVideo) {
            if (!authorized(secret)) return;
            networkOffline = offline;
            relayOnly = proxyVideo;
            String safeInstance = "";
            try {
                Uri uri = Uri.parse(instance == null ? "" : instance);
                if ("https".equals(uri.getScheme()) && uri.getHost() != null && uri.getUserInfo() == null
                        && uri.getQuery() == null && uri.getFragment() == null) safeInstance = uri.toString();
            } catch (Exception ignored) { }
            onlineClient.configure(offline, safeInstance);
            getSharedPreferences("network", MODE_PRIVATE).edit().putBoolean("offline", offline).apply();
            runOnUiThread(new Runnable() {
                @Override public void run() { if (webView != null) webView.getSettings().setBlockNetworkLoads(offline); }
            });
        }

        @JavascriptInterface
        public void requestJson(String secret, String id, String url) {
            if (authorized(secret)) onlineClient.request(id, url);
        }
        @JavascriptInterface
        public void cancelJson(String secret, String id) {
            if (authorized(secret)) onlineClient.cancel(id);
        }

        @JavascriptInterface
        public void shareLink(String secret, final String url, final String title) {
            if (!authorized(secret) || !validYouTubeUrl(url)) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_TEXT, (title == null ? "" : title + "\n") + url);
                    try { startActivity(Intent.createChooser(send, "Поделиться ссылкой")); }
                    catch (Exception error) { Toast.makeText(MainActivity.this, "Нет приложения для отправки", Toast.LENGTH_SHORT).show(); }
                }
            });
        }
        @JavascriptInterface
        public void openExternal(String secret, final String url) {
            if (!authorized(secret) || networkOffline || !validYouTubeUrl(url)) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                    catch (Exception error) { Toast.makeText(MainActivity.this, "Нет приложения для открытия ссылки", Toast.LENGTH_SHORT).show(); }
                }
            });
        }

        @JavascriptInterface
        public void setBars(String secret, final boolean dark) {
            if (!authorized(secret)) return;
            runOnUiThread(new Runnable() {
                @Override public void run() { updateBars(dark); }
            });
        }

        @JavascriptInterface
        public void beginExport(String secret, final String mode, final String name, final String mime) {
            if (!authorized(secret)) return;
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    synchronized (exportLock) {
                        if (exportMode != null || (!"save".equals(mode) && !"share".equals(mode))) {
                            exportReady(false);
                            return;
                        }
                        exportMode = mode;
                        exportName = name == null ? "video.mp4"
                                : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                        if (exportName.isEmpty()) exportName = "video.mp4";
                        if (exportName.length() > 140) exportName = exportName.substring(0, 140);
                        exportMime = mime != null && mime.startsWith("video/") ? mime : "video/mp4";
                    }
                    if ("share".equals(mode)) {
                        try {
                            synchronized (exportLock) {
                                exportStream = new FileOutputStream(new File(getCacheDir(), "shared-video"));
                            }
                            exportReady(true);
                        } catch (IOException error) {
                            discardExport();
                            exportReady(false);
                        }
                    } else {
                        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        save.addCategory(Intent.CATEGORY_OPENABLE);
                        save.setType(exportMime);
                        save.putExtra(Intent.EXTRA_TITLE, exportName);
                        try {
                            startActivityForResult(save, SAVE_VIDEO);
                        } catch (Exception error) {
                            discardExport();
                            exportReady(false);
                            Toast.makeText(MainActivity.this, "Не удалось открыть сохранение", Toast.LENGTH_SHORT).show();
                        }
                    }
                }
            });
        }

        @JavascriptInterface
        public boolean appendExport(String secret, String chunk) {
            if (!authorized(secret)) return false;
            // WebView вызывает методы JS-интерфейса не в UI-потоке.
            synchronized (exportLock) {
                if (exportStream == null || chunk == null || chunk.length() > 100000) return false;
                try {
                    exportStream.write(Base64.decode(chunk, Base64.DEFAULT));
                    return true;
                } catch (Exception error) {
                    return false;
                }
            }
        }

        @JavascriptInterface
        public boolean finishExport(String secret) {
            if (!authorized(secret)) return false;
            final String mode;
            final String name;
            final String mime;
            synchronized (exportLock) {
                if (exportStream == null || exportMode == null) return false;
                mode = exportMode;
                name = exportName;
                mime = exportMime;
                try {
                    exportStream.flush();
                    exportStream.close();
                } catch (IOException error) {
                    discardExport();
                    return false;
                }
                exportStream = null;
                exportMode = null;
            }
            if ("share".equals(mode)) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        getSharedPreferences("share", MODE_PRIVATE).edit()
                                .putString("name", name).putString("mime", mime).apply();
                        Uri uri = Uri.parse("content://app.ytlocal.player.share/video");
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType(mime);
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.setClipData(ClipData.newUri(getContentResolver(), name, uri));
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        Intent chooser = Intent.createChooser(send, "Поделиться видео");
                        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        try { startActivity(chooser); }
                        catch (Exception error) {
                            Toast.makeText(MainActivity.this, "Нет приложения для отправки", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }
            return true;
        }

        @JavascriptInterface
        public void abortExport(String secret) { if (authorized(secret)) discardExport(); }
    }

    @Override
    public void onBackPressed() {
        if (fullScreenView != null) { hideFullScreen(); return; }
        if (webView == null) { super.onBackPressed(); return; }
        webView.evaluateJavascript("window.handleAndroidBack ? window.handleAndroidBack() : false",
                new ValueCallback<String>() {
                    @Override public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) MainActivity.super.onBackPressed();
                    }
                });
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("document.querySelectorAll('video').forEach(function(v){v.pause()}); window.pauseOnlinePlayer && window.pauseOnlinePlayer()", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) { webView.onResume(); notifyNetwork(); }
    }

    @Override
    protected void onDestroy() {
        discardExport();
        if (connectivity != null && networkCallback != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { }
        }
        if (onlineClient != null) onlineClient.close();
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
