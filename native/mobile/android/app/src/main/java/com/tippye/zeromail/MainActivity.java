package com.tippye.zeromail;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebStorageCompat;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PICK_FILES = 10, SAVE_FILE = 11, NOTIFICATION_PERMISSION = 12;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private final AttachmentTransfer transfer = new AttachmentTransfer();
    private final Runnable transferTimeout = () -> { transfer.close(); toast(R.string.save_failed); };
    private SharedPreferences preferences;
    private LinearLayout root;
    private FrameLayout content;
    private ProgressBar progress;
    private WebView web;
    private View errorView;
    private String server = "", pendingPath, lastUrl;
    private boolean loadingFailed, clearing, httpDownloading;
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("zero", MODE_PRIVATE);
        server = preferences.getString("server", "");
        try { if (!server.isEmpty()) server = UrlPolicy.server(server, preferences.getBoolean("allowHttp", false)); }
        catch (IllegalArgumentException e) { server = ""; }
        if (state != null) pendingPath = state.getString("pendingPath");
        else acceptIntent(getIntent(), false);
        // Orphaned attachment cache is never retained across process restarts.
        File[] abandoned = getCacheDir().listFiles((directory, name) -> name.startsWith("attachment-"));
        if (abandoned != null) for (File file : abandoned) file.delete();
        if (server.isEmpty()) showSettings();
        else {
            connect();
            String restored = state == null ? null : state.getString("url");
            if (restored != null && UrlPolicy.sameOrigin(server, restored)) web.loadUrl(restored);
        }
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::goBack);
        MailNotificationJob.schedule(this);
    }

    private void frame(boolean mail) {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.surface));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.requestApplyInsets();
        if (!mail) {
            TextView title = text("Zero Mail", 19, R.color.text_primary);
            title.setPadding(dp(24), dp(16), dp(24), dp(8));
            root.addView(title);
        }
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setVisibility(View.GONE);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(2)));
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
    }

    private void showSettings() {
        if (clearing) return;
        // Keep the current page alive so cancel/back preserves its editor and history.
        if (web != null && web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        frame(false);
        ScrollView scroll = new ScrollView(this);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(48), dp(24), dp(24));
        scroll.addView(form);
        content.addView(scroll);
        form.addView(text(getString(R.string.connect_title), 28, R.color.text_primary));
        TextView description = text(getString(R.string.connect_description), 16, R.color.text_secondary);
        description.setPadding(0, dp(16), 0, dp(32));
        form.addView(description);
        TextView label = text(getString(R.string.server_label), 14, R.color.text_secondary);
        form.addView(label);
        EditText address = new EditText(this);
        address.setId(R.id.server_address);
        label.setLabelFor(R.id.server_address);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint(R.string.server_hint);
        address.setText(server);
        form.addView(address, new LinearLayout.LayoutParams(-1, dp(56)));
        CheckBox http = new CheckBox(this);
        http.setId(R.id.allow_http);
        http.setText(R.string.allow_http);
        http.setChecked(preferences.getBoolean("allowHttp", false));
        form.addView(http);
        Button connect = button(getString(R.string.connect), v -> {
            final String next;
            try { next = UrlPolicy.server(address.getText().toString(), http.isChecked()); }
            catch (IllegalArgumentException e) { address.setError(getString(R.string.invalid_server)); return; }
            Runnable change = () -> clearSession(() -> {
                server = next;
                preferences.edit().putString("server", server).putBoolean("allowHttp", http.isChecked()).apply();
                connect();
                MailNotificationJob.schedule(this);
            });
            if (next.equals(server) && web != null) {
                preferences.edit().putBoolean("allowHttp", http.isChecked()).apply();
                restoreMail();
                deliverPending();
            } else if (server.isEmpty()) change.run();
            else confirm(R.string.switch_confirm, change);
        });
        connect.setId(R.id.connect_server);
        form.addView(connect, new LinearLayout.LayoutParams(-1, dp(56)));
        TextView help = text(getString(R.string.server_help), 14, R.color.text_secondary);
        help.setPadding(0, dp(24), 0, 0);
        form.addView(help);
        if (!server.isEmpty()) {
            form.addView(button(getString(preferences.getBoolean("notifications", false) ? R.string.notifications_disable : R.string.notifications_enable), v -> {
                if (preferences.getBoolean("notifications", false)) {
                    preferences.edit().putBoolean("notifications", false).apply();
                    MailNotificationJob.cancel(this);
                    showSettings();
                } else confirm(R.string.notifications_description, this::enableNotifications);
            }));
            form.addView(button(getString(R.string.clear_session), v -> confirm(R.string.clear_confirm, () -> clearSession(this::connect))));
        }
    }

    private void restoreMail() {
        if (web == null) { connect(); return; }
        if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
        frame(true);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        errorView = null;
        if (loadingFailed) showError(R.string.connection_error);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void connect() {
        destroyWeb();
        frame(true);
        web = new WebView(this);
        web.setId(R.id.mail_webview);
        web.setBackgroundColor(getColor(R.color.surface));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " ZeroMailAndroid/1.0.1");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        installAttachmentBridge();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "ZeroAndroidSettings", Collections.singleton(server), (view, message, origin, mainFrame, reply) -> {
                if (view != web || !mainFrame || !UrlPolicy.sameOrigin(server, origin.toString()) || !"open".equals(message.getData())) return;
                String path = Uri.parse(view.getUrl()).getPath();
                if (path != null && (path.startsWith("/settings/") || path.equals("/login"))) showSettings();
            });
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !UrlPolicy.sameOrigin(server, request.getUrl().toString());
                return route(request.getUrl().toString(), request.hasGesture());
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (view != web) return;
                lastUrl = url;
                loadingFailed = false;
                if (errorView != null) { content.removeView(errorView); errorView = null; }
                transfer.close();
                handler.removeCallbacks(transferTimeout);
                progress.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (view != web) return;
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                if (UrlPolicy.sameOrigin(server, url) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                        && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(attachmentScript(), null);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == web && request.isForMainFrame()) showError(R.string.connection_error);
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (view == web && request.isForMainFrame() && response.getStatusCode() >= 400) showError(R.string.connection_error);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler ssl, SslError error) {
                ssl.cancel();
                if (view == web) showError(R.string.certificate_error);
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view == web) { destroyWeb(); frame(true); showError(R.string.connection_error); }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { if (view == web) progress.setProgress(value); }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton(android.R.string.ok, (d, w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show();
                return true;
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                jsConfirm(message, result); return true;
            }
            @Override public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
                jsConfirm(getString(R.string.leave_confirm), result); return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                cancelFilePicker();
                if (view != web || !UrlPolicy.sameOrigin(server, view.getUrl())) { callback.onReceiveValue(null); return true; }
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                ArrayList<String> types = new ArrayList<>();
                for (String type : params.getAcceptTypes()) if (type.matches("[a-zA-Z0-9.+*-]+/[a-zA-Z0-9.+*-]+")) types.add(type);
                if (!types.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, PICK_FILES); }
                catch (ActivityNotFoundException e) { cancelFilePicker(); toast(R.string.file_unavailable); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message message) {
                if (!gesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
                        String url = request.getUrl().toString();
                        if (!route(url, true) && web != null) navigateUrl(url);
                        popup.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) message.obj).setWebView(popup);
                message.sendToTarget();
                handler.postDelayed(() -> { if (!isDestroyed()) popup.destroy(); }, 10000);
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            // Blob/data attachments are handled before navigation by the origin-scoped bridge.
            if (url.startsWith("blob:") || url.startsWith("data:")) toast(R.string.webview_update);
            else if (UrlPolicy.sameOrigin(server, url)) downloadHttp(url, android.webkit.URLUtil.guessFileName(url, disposition, mime), mime);
        });
        String path = pendingPath == null ? "/mail/inbox" : pendingPath;
        pendingPath = null;
        web.loadUrl(server + path);
    }

    private boolean route(String raw, boolean gesture) {
        if (UrlPolicy.sameOrigin(server, raw)) return false;
        if (!gesture) return true;
        if (raw.regionMatches(true, 0, "mailto:", 0, 7) || raw.regionMatches(true, 0, "zeromail:", 0, 9)) {
            try { navigate(UrlPolicy.linkPath(raw)); } catch (IllegalArgumentException e) { toast(R.string.invalid_link); }
        } else openExternal(raw);
        return true;
    }
    private void openExternal(String raw) {
        Uri uri = Uri.parse(raw);
        if (!("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()) || "tel".equalsIgnoreCase(uri.getScheme()))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException | SecurityException e) { toast(R.string.external_unavailable); }
    }
    private void navigate(String path) {
        if (web == null) { pendingPath = path; if (!server.isEmpty()) connect(); return; }
        restoreMail();
        navigateUrl(server + path);
    }
    private void navigateUrl(String url) {
        if (web == null || !UrlPolicy.sameOrigin(server, url)) return;
        if (loadingFailed) web.loadUrl(url);
        else web.evaluateJavascript("window.location.assign(" + JSONObject.quote(url) + ")", null);
    }
    private void deliverPending() { if (pendingPath != null) { String path = pendingPath; pendingPath = null; navigate(path); } }
    private void clearSession(Runnable after) {
        clearing = true;
        MailNotificationJob.cancel(this);
        preferences.edit().remove("notificationState").putInt("generation", preferences.getInt("generation", 0) + 1).apply();
        destroyWeb();
        Runnable done = () -> {
            CookieManager.getInstance().flush();
            clearing = false;
            if (!isDestroyed()) after.run();
        };
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            WebStorageCompat.deleteBrowsingData(WebStorage.getInstance(), done);
        } else {
            WebStorage.getInstance().deleteAllData();
            CookieManager.getInstance().removeAllCookies(removed -> done.run());
        }
    }
    private void destroyWeb() {
        cancelFilePicker();
        handler.removeCallbacks(transferTimeout);
        transfer.close();
        httpDownloading = false;
        if (web != null) {
            web.stopLoading();
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            if (clearing) { web.clearCache(true); web.clearHistory(); web.clearFormData(); }
            web.destroy();
            web = null;
        }
        errorView = null;
    }
    private void showError(int message) {
        loadingFailed = true;
        progress.setVisibility(View.GONE);
        if (errorView != null) content.removeView(errorView);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.setBackgroundColor(getColor(R.color.surface));
        panel.addView(text(getString(message), 17, R.color.text_primary));
        panel.addView(button(getString(R.string.retry), v -> { if (web == null) connect(); else web.loadUrl(UrlPolicy.sameOrigin(server, lastUrl) ? lastUrl : server + "/mail/inbox"); }));
        panel.addView(button(getString(R.string.settings), v -> showSettings()));
        errorView = panel;
        content.addView(panel, new FrameLayout.LayoutParams(-1, -1));
    }

    private void installAttachmentBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(web, "ZeroAttachments", Collections.singleton(server), (view, message, origin, mainFrame, reply) -> {
            if (view != web || !mainFrame || !UrlPolicy.sameOrigin(server, origin.toString())) return;
            String id = "";
            try {
                String data = message.getData();
                if (data == null || data.length() > 140000) throw new IllegalArgumentException();
                JSONObject body = new JSONObject(data);
                id = body.getString("id");
                if (body.getString("type").equals("start") && (transfer.file() != null || httpDownloading)) {
                    reply.postMessage("{\"id\":" + JSONObject.quote(id) + ",\"error\":\"请先完成当前附件的保存。\"}");
                    return;
                }
                switch (body.getString("type")) {
                    case "start": transfer.start(getCacheDir(), body); break;
                    case "chunk": transfer.chunk(body); break;
                    case "finish": transfer.finish(body); break;
                    case "abort":
                        if (transfer.matches(id) && !transfer.complete()) { transfer.close(); handler.removeCallbacks(transferTimeout); }
                        return;
                    default: throw new IllegalArgumentException();
                }
                handler.removeCallbacks(transferTimeout);
                if (transfer.complete()) chooseDestination();
                else handler.postDelayed(transferTimeout, 30000);
                reply.postMessage(new JSONObject().put("id", id).toString());
            } catch (Exception e) {
                handler.removeCallbacks(transferTimeout);
                transfer.close();
                reply.postMessage("{\"id\":" + JSONObject.quote(id) + ",\"error\":\"附件保存失败，请一次保存一个附件（最大 25 MB）。\"}");
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            WebViewCompat.addDocumentStartJavaScript(web, attachmentScript(), Collections.singleton(server));
    }
    private String attachmentScript() {
        try (InputStream input = getAssets().open("attachments.js"); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }
    private void chooseDestination() {
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(transfer.mime()).putExtra(Intent.EXTRA_TITLE, transfer.name());
        try { startActivityForResult(save, SAVE_FILE); }
        catch (ActivityNotFoundException e) { transfer.close(); toast(R.string.file_unavailable); }
    }
    private void downloadHttp(String url, String name, String mime) {
        // Use the current server session only; never forward cookies through redirects.
        if (transfer.file() != null || httpDownloading) { toast(R.string.download_limit); return; }
        httpDownloading = true;
        final String activeServer = server;
        final WebView activeWeb = web;
        String cookies = CookieManager.getInstance().getCookie(url);
        files.execute(() -> {
            try {
                byte[] bytes = ServerRequest.get(url, cookies, AttachmentTransfer.MAX_BYTES);
                runOnUiThread(() -> {
                    if (isDestroyed() || activeWeb != web || !activeServer.equals(server)) return;
                    httpDownloading = false;
                    try {
                        JSONObject start = new JSONObject().put("id", "http-download").put("name", name).put("mime", mime).put("size", bytes.length);
                        transfer.start(getCacheDir(), start);
                        for (int offset = 0, seq = 0; offset < bytes.length; offset += 65536, seq++) {
                            int length = Math.min(65536, bytes.length - offset);
                            transfer.chunk(new JSONObject().put("id", "http-download").put("seq", seq).put("data", android.util.Base64.encodeToString(bytes, offset, length, android.util.Base64.NO_WRAP)));
                        }
                        transfer.finish(start);
                        chooseDestination();
                    } catch (Exception e) { transfer.close(); toast(R.string.save_failed); }
                });
            } catch (Exception e) { runOnUiThread(() -> { if (activeWeb == web) { httpDownloading = false; toast(R.string.save_failed); } }); }
        });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && fileCallback != null) {
            ArrayList<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) for (int i = 0; i < Math.min(30, data.getClipData().getItemCount()); i++) selected.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) selected.add(data.getData());
            }
            selected.removeIf(uri -> uri == null || !"content".equals(uri.getScheme()));
            fileCallback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
            fileCallback = null;
        } else if (request == SAVE_FILE) {
            if (result != RESULT_OK || data == null || data.getData() == null || !"content".equals(data.getData().getScheme()) || !transfer.complete()) { transfer.close(); return; }
            Uri destination = data.getData();
            File source = transfer.file();
            files.execute(() -> {
                boolean success = false;
                try (InputStream input = new FileInputStream(source); OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null) throw new java.io.IOException("Missing destination");
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    success = true;
                } catch (Exception ignored) { }
                final boolean saved = success;
                runOnUiThread(() -> { transfer.close(); if (!isDestroyed()) toast(saved ? R.string.saved : R.string.save_failed); });
            });
        }
    }
    private void cancelFilePicker() { if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; } }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); acceptIntent(intent, true); }
    private void acceptIntent(Intent intent, boolean deliver) {
        if (intent == null) return;
        try {
            String action = intent.getAction(), path = null;
            if ((Intent.ACTION_VIEW.equals(action) || Intent.ACTION_SENDTO.equals(action)) && intent.getDataString() != null) path = UrlPolicy.linkPath(intent.getDataString());
            else if (Intent.ACTION_SEND.equals(action) && "text/plain".equals(intent.getType())) {
                Map<String, String> fields = new LinkedHashMap<>();
                CharSequence body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (body != null) fields.put("body", body.toString());
                if (subject != null) fields.put("subject", subject);
                path = UrlPolicy.composePath(fields);
            } else if ("com.tippye.zeromail.NOTIFICATION".equals(action)
                    && server.equals(intent.getStringExtra("server"))
                    && preferences.getInt("generation", 0) == intent.getIntExtra("generation", -1)) {
                path = UrlPolicy.notificationPath(intent.getStringExtra("threadId"));
            }
            if (path != null) { pendingPath = path; if (deliver && !server.isEmpty()) deliverPending(); }
        } catch (Exception e) { toast(R.string.invalid_link); }
    }
    private void enableNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
        else { preferences.edit().putBoolean("notifications", true).apply(); MailNotificationJob.schedule(this); showSettings(); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATION_PERMISSION) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) enableNotifications();
            else toast(R.string.notification_permission);
        }
    }
    private void goBack() {
        if (clearing) return;
        if (web != null && web.getParent() != content) { restoreMail(); deliverPending(); }
        else if (web != null && web.canGoBack()) {
            android.webkit.WebBackForwardList history = web.copyBackForwardList();
            String previous = history.getItemAtIndex(history.getCurrentIndex() - 1).getUrl();
            if ("/login".equals(Uri.parse(previous).getPath())) moveTaskToBack(true);
            else web.goBack();
        }
        else if (!server.isEmpty() && web == null) connect();
        else moveTaskToBack(true);
    }
    @Override public void onBackPressed() { goBack(); }
    @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (web != null && UrlPolicy.sameOrigin(server, web.getUrl())) state.putString("url", web.getUrl());
        state.putString("pendingPath", pendingPath);
    }
    @Override protected void onDestroy() { handler.removeCallbacksAndMessages(null); destroyWeb(); files.shutdown(); super.onDestroy(); }
    private void confirm(int message, Runnable action) { new AlertDialog.Builder(this).setMessage(message).setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.continue_action, (d, w) -> action.run()).show(); }
    private void jsConfirm(String message, JsResult result) { new AlertDialog.Builder(this).setMessage(message).setNegativeButton(R.string.cancel, (d, w) -> result.cancel()).setPositiveButton(R.string.continue_action, (d, w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); }
    private void toast(int message) { if (!isDestroyed()) Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(getColor(color)); return view; }
    private Button button(String label, View.OnClickListener action) { Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setOnClickListener(action); return button; }
}
