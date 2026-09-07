package com.tippye.zeromail;

import android.content.Context;
import android.content.Intent;
import android.app.Instrumentation;
import android.content.ContentValues;
import android.content.IntentFilter;
import android.provider.MediaStore;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.CheckBox;
import android.widget.EditText;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiSelector;
import androidx.test.uiautomator.UiScrollable;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AndroidClientTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private ServerSocket server;
    private Thread fixture;
    private String origin;
    private final java.util.concurrent.atomic.AtomicInteger mailCount = new java.util.concurrent.atomic.AtomicInteger();

    @Before public void prepare() throws Exception {
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().clear().commit();
        CountDownLatch cleared = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> CookieManager.getInstance().removeAllCookies(done -> cleared.countDown()));
        assertTrue(cleared.await(10, TimeUnit.SECONDS));
        server = new ServerSocket(0);
        origin = "http://127.0.0.1:" + server.getLocalPort();
        fixture = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(5000);
                    BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    String line = input.readLine();
                    if (line == null) continue;
                    String path = line.split(" ")[1];
                    while (!(line = input.readLine()).isEmpty()) { }
                    String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body>"
                            + "<h1>Zero test workspace</h1><p id='path'></p><input id='attachment' type='file' multiple>"
                            + "<script>document.getElementById('path').textContent=location.pathname;</script></body></html>";
                    boolean feed = path.startsWith("/api/desktop/events");
                    if (feed) {
                        String events = path.endsWith("after=0") && mailCount.get() > 0 ? "[{\"id\":\"1\",\"threadId\":\"mbx.test.thread\",\"subject\":\"private subject\"}]" : "[]";
                        html = "{\"owner\":\"fixture-user\",\"cursor\":\"" + mailCount.get() + "\",\"events\":" + events + "}";
                    }
                    byte[] body = html.getBytes(StandardCharsets.UTF_8);
                    String headers = "HTTP/1.1 200 OK\r\nContent-Type: " + (feed ? "application/json" : "text/html; charset=utf-8") + "\r\nConnection: close\r\nCache-Control: no-store\r\n"
                            + (path.equals("/mail/inbox") ? "Set-Cookie: fixture_session=android-test; HttpOnly; SameSite=Lax; Path=/\r\n" : "")
                            + "Content-Length: " + body.length + "\r\n\r\n";
                    socket.getOutputStream().write(headers.getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().write(body);
                } catch (Exception ignored) { }
            }
        }, "zero-android-fixture");
        fixture.start();
    }
    @After public void cleanup() throws Exception { server.close(); fixture.join(3000); }

    @Test public void nativeConnectionRequiresHttpConsentAndPreservesSessionAcrossRecreation() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                ((EditText) activity.findViewById(R.id.server_address)).setText(origin);
                activity.findViewById(R.id.connect_server).performClick();
                assertNotNull(((EditText) activity.findViewById(R.id.server_address)).getError());
                assertNull(activity.findViewById(R.id.mail_webview));
                ((CheckBox) activity.findViewById(R.id.allow_http)).setChecked(true);
                activity.findViewById(R.id.connect_server).performClick();
            });
            await(scenario, "document.querySelector('h1')?.textContent === 'Zero test workspace'");
            await(scenario, "typeof ZeroAttachments === 'object' && window.__zeroAttachmentsReady === true");
            await(scenario, "document.cookie.indexOf('fixture_session') === -1");
            scenario.onActivity(activity -> assertTrue(CookieManager.getInstance().getCookie(origin).contains("fixture_session=android-test")));
            scenario.recreate();
            await(scenario, "location.pathname === '/mail/inbox' && document.readyState === 'complete'");
            scenario.onActivity(activity -> assertTrue(CookieManager.getInstance().getCookie(origin).contains("fixture_session=android-test")));
        }
    }

    @Test public void coldAndWarmMailLinksKeepComposeFields() throws Exception {
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("server", origin).putBoolean("allowHttp", true).commit();
        Intent cold = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("mailto:first+tag@example.com?subject=%E4%B8%AD%E6%96%87&body=first%0Asecond"));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(cold)) {
            await(scenario, "location.pathname === '/mail/compose' && new URLSearchParams(location.search).get('to') === 'first+tag@example.com'");
            await(scenario, "new URLSearchParams(location.search).get('body') === 'first\\nsecond'");
            scenario.onActivity(activity -> activity.startActivity(new Intent(activity, MainActivity.class).setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse("zeromail://compose?to=second@example.com&subject=Warm"))));
            await(scenario, "new URLSearchParams(location.search).get('subject') === 'Warm'");
            scenario.onActivity(activity -> activity.startActivity(new Intent(activity, MainActivity.class).setAction(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, "https://example.com/?q=a+b")));
            await(scenario, "new URLSearchParams(location.search).get('body') === 'https://example.com/?q=a+b'");
        }
    }

    @Test public void attachmentTransferEnforcesOrderAndSizeAndRemovesPrivateCache() throws Exception {
        File cache = context.getCacheDir();
        JSONObject start = new JSONObject().put("id", "test").put("size", 4).put("name", "../中文.txt").put("mime", "text/plain");
        try (AttachmentTransfer transfer = new AttachmentTransfer()) {
            transfer.start(cache, start);
            assertEquals(".._中文.txt", transfer.name());
            JSONObject chunk = new JSONObject().put("id", "test").put("seq", 0).put("data", "dGVzdA==");
            transfer.chunk(chunk);
            assertThrows(Exception.class, () -> transfer.chunk(chunk));
            transfer.finish(start);
            File file = transfer.file();
            assertArrayEquals("test".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file.toPath()));
            transfer.close();
            assertFalse(file.exists());
            assertThrows(Exception.class, () -> transfer.start(cache, new JSONObject(start.toString()).put("size", AttachmentTransfer.MAX_BYTES + 1)));
            transfer.start(cache, start);
            assertThrows(Exception.class, () -> transfer.finish(start));
        }
    }

    @Test public void systemDocumentPickerUploadsAndSavesExactAttachmentBytes() throws Exception {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 29);
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("server", origin).putBoolean("allowHttp", true).commit();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, "zero-android-fixture.txt");
        values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
        Uri document = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        assertNotNull(document);
        try {
            try (java.io.OutputStream output = context.getContentResolver().openOutputStream(document)) { output.write("附件 test".getBytes(StandardCharsets.UTF_8)); }
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                await(scenario, "document.getElementById('attachment') !== null && window.__zeroAttachmentsReady === true");
                IntentFilter uploadFilter = new IntentFilter(Intent.ACTION_OPEN_DOCUMENT);
                uploadFilter.addDataType("*/*");
                uploadFilter.addCategory(Intent.CATEGORY_OPENABLE);
                Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
                Instrumentation.ActivityMonitor upload = instrumentation.addMonitor(uploadFilter,
                        new Instrumentation.ActivityResult(android.app.Activity.RESULT_OK, new Intent().setData(document)), true);
                try {
                    CountDownLatch positionReady = new CountDownLatch(1);
                    int[] position = new int[2];
                    scenario.onActivity(activity -> {
                        WebView web = activity.findViewById(R.id.mail_webview);
                        web.getLocationOnScreen(position);
                        web.evaluateJavascript("(()=>{const input=document.getElementById('attachment');input.onchange=async(e)=>{try{window.uploaded=await e.target.files[0].text()}catch(error){window.uploadError=String(error)}};const r=input.getBoundingClientRect();return [(r.x+r.width/2)*devicePixelRatio,(r.y+r.height/2)*devicePixelRatio]})()", value -> {
                            try {
                                org.json.JSONArray point = new org.json.JSONArray(value);
                                position[0] += (int) Math.round(point.getDouble(0));
                                position[1] += (int) Math.round(point.getDouble(1));
                            } catch (Exception e) { throw new AssertionError(e); }
                            positionReady.countDown();
                        });
                    });
                    assertTrue(positionReady.await(10, TimeUnit.SECONDS));
                    UiDevice.getInstance(instrumentation).click(position[0], position[1]);
                    await(scenario, "window.uploaded === '附件 test'");
                    assertEquals(1, upload.getHits());
                } finally { instrumentation.removeMonitor(upload); }

                IntentFilter saveFilter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
                saveFilter.addDataType("*/*");
                saveFilter.addCategory(Intent.CATEGORY_OPENABLE);
                Instrumentation.ActivityMonitor save = instrumentation.addMonitor(saveFilter,
                        new Instrumentation.ActivityResult(android.app.Activity.RESULT_OK, new Intent().setData(document)), true);
                try {
                    scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).evaluateJavascript(
                            "var blob=new Blob(['保存 exact + % 中文'],{type:'text/plain'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='中文.txt';document.body.append(a);a.click();URL.revokeObjectURL(a.href);a.remove()", null));
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                    String contents = "";
                    while (System.nanoTime() < deadline) {
                        try (java.io.InputStream input = context.getContentResolver().openInputStream(document); java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
                            byte[] buffer = new byte[1024]; int count;
                            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                            contents = output.toString("UTF-8");
                        }
                        if (contents.equals("保存 exact + % 中文")) break;
                        Thread.sleep(200);
                    }
                    assertEquals(1, save.getHits());
                    assertEquals("保存 exact + % 中文", contents);
                } finally { instrumentation.removeMonitor(save); }
            }
        } finally { context.getContentResolver().delete(document, null, null); }
    }

    @Test public void clearSessionRemovesWebStorageAndNotificationState() throws Exception {
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("server", origin).putBoolean("allowHttp", true).commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "document.readyState === 'complete' && location.pathname === '/mail/inbox'");
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).evaluateJavascript("localStorage.setItem('private','old-mail')", null));
            await(scenario, "localStorage.getItem('private') === 'old-mail'");
            context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("notificationState", "test-state").commit();
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            assertFalse(device.findObject(new UiSelector().description("应用菜单")).exists());
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).loadUrl(origin + "/settings/general"));
            await(scenario, "document.readyState === 'complete' && location.pathname === '/settings/general' && !!window.ZeroAndroidSettings");
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).evaluateJavascript("ZeroAndroidSettings.postMessage('open')", null));
            assertTrue(device.findObject(new UiSelector().resourceId("com.tippye.zeromail:id/server_address")).waitForExists(10000));
            new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("清除本机登录与缓存"));
            device.findObject(new UiSelector().text("清除本机登录与缓存")).click();
            device.findObject(new UiSelector().text("继续")).click();
            await(scenario, "location.pathname === '/mail/inbox' && document.readyState === 'complete' && localStorage.getItem('private') === null");
            assertFalse(context.getSharedPreferences("zero", Context.MODE_PRIVATE).contains("notificationState"));
        }
    }

    @Test public void mailHasNoNativeToolbarAndBackDoesNotReturnToLogin() throws Exception {
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("server", origin).putBoolean("allowHttp", true).commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "document.readyState === 'complete'");
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            assertFalse(device.findObject(new UiSelector().description("应用菜单")).exists());
            assertFalse(device.findObject(new UiSelector().description("返回")).exists());
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).loadUrl(origin + "/login"));
            await(scenario, "document.readyState === 'complete' && location.pathname === '/login'");
            scenario.onActivity(activity -> ((WebView) activity.findViewById(R.id.mail_webview)).loadUrl(origin + "/mail/inbox"));
            await(scenario, "document.readyState === 'complete' && location.pathname === '/mail/inbox'");
            scenario.onActivity(MainActivity::onBackPressed);
            scenario.onActivity(activity -> assertEquals(origin + "/mail/inbox", ((WebView) activity.findViewById(R.id.mail_webview)).getUrl()));
        }
    }

    @Test public void backgroundNotificationUsesBaselineDeduplicatesAndHidesMailContent() throws Exception {
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        manager.cancelAll();
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        if (android.os.Build.VERSION.SDK_INT >= 33) device.executeShellCommand("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS");
        context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putString("server", origin).putBoolean("allowHttp", true).commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            await(scenario, "document.readyState === 'complete' && location.pathname === '/mail/inbox'");
            context.getSharedPreferences("zero", Context.MODE_PRIVATE).edit().putBoolean("notifications", true).apply();
            scenario.onActivity(activity -> MailNotificationJob.schedule(activity));
            device.executeShellCommand("cmd jobscheduler run -f " + context.getPackageName() + " 1001");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!context.getSharedPreferences("zero", Context.MODE_PRIVATE).contains("notificationState") && System.nanoTime() < deadline) Thread.sleep(200);
            assertTrue(context.getSharedPreferences("zero", Context.MODE_PRIVATE).contains("notificationState"));
            assertEquals(0, manager.getActiveNotifications().length);
            mailCount.set(1);
            device.executeShellCommand("cmd jobscheduler run -f " + context.getPackageName() + " 1001");
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (manager.getActiveNotifications().length == 0 && System.nanoTime() < deadline) Thread.sleep(200);
            assertEquals(1, manager.getActiveNotifications().length);
            android.app.Notification notification = manager.getActiveNotifications()[0].getNotification();
            assertEquals(context.getString(R.string.notification_body), notification.extras.getString(android.app.Notification.EXTRA_TEXT));
            long timestamp = notification.when;
            device.executeShellCommand("cmd jobscheduler run -f " + context.getPackageName() + " 1001");
            Thread.sleep(1000);
            assertEquals(1, manager.getActiveNotifications().length);
            assertEquals(timestamp, manager.getActiveNotifications()[0].getNotification().when);
        } finally { MailNotificationJob.cancel(context); }
    }

    private void await(ActivityScenario<MainActivity> scenario, String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            scenario.onActivity(activity -> {
                WebView web = activity.findViewById(R.id.mail_webview);
                if (web == null) { latch.countDown(); return; }
                web.evaluateJavascript("Boolean(" + expression + ")", value -> { result.set(value); latch.countDown(); });
            });
            latch.await(5, TimeUnit.SECONDS);
            if ("true".equals(result.get())) return;
            Thread.sleep(200);
        }
        AtomicReference<String> error = new AtomicReference<>();
        CountDownLatch diagnostics = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.mail_webview);
            if (web == null) { diagnostics.countDown(); return; }
            web.evaluateJavascript("window.uploadError || document.body.innerText", value -> { error.set(value); diagnostics.countDown(); });
        });
        diagnostics.await(5, TimeUnit.SECONDS);
        fail("WebView condition not reached: " + expression + "; page: " + error.get());
    }
}
