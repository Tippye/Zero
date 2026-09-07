package com.tippye.zeromail;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;

/** Periodic mail checking, subject to Android's background scheduling and battery policy. */
public final class MailNotificationJob extends JobService {
    private static final int JOB_ID = 1001;
    private static final String CHANNEL = "mail";
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Thread worker;

    static void schedule(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("zero", MODE_PRIVATE);
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (!preferences.getBoolean("notifications", false) || preferences.getString("server", "").isEmpty()) { cancel(context); return; }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_DEFAULT));
        if (scheduler.getPendingJob(JOB_ID) == null) scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, MailNotificationJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .setBackoffCriteria(60000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build());
    }
    static void cancel(Context context) {
        context.getSystemService(JobScheduler.class).cancel(JOB_ID);
        context.getSystemService(NotificationManager.class).cancelAll();
    }

    @Override public boolean onStartJob(JobParameters parameters) {
        if (worker != null) return false;
        SharedPreferences preferences = getSharedPreferences("zero", MODE_PRIVATE);
        if (!preferences.getBoolean("notifications", false)) return false;
        final String server;
        try { server = UrlPolicy.server(preferences.getString("server", ""), preferences.getBoolean("allowHttp", false)); }
        catch (IllegalArgumentException e) { return false; }
        int generation = preferences.getInt("generation", 0);
        String cookie = CookieManager.getInstance().getCookie(server + "/api/desktop/events");
        if (cookie == null || cookie.isEmpty()) return false;
        String saved = preferences.getString("notificationState", "{}");
        Thread task = new Thread(() -> {
            Thread current = Thread.currentThread();
            try {
                JSONObject head = fetch(server, cookie, null);
                String owner = head.getString("owner");
                JSONObject previous = new JSONObject(saved);
                Set<String> seen = new LinkedHashSet<>();
                JSONArray storedIds = previous.optJSONArray("seen");
                if (storedIds != null) for (int i = 0; i < storedIds.length(); i++) seen.add(storedIds.getString(i));
                JSONArray events = new JSONArray();
                String cursor = head.getString("cursor");
                if (owner.equals(previous.optString("owner")) && server.equals(previous.optString("server")) && previous.optString("cursor").matches("[0-9]+")) {
                    JSONObject page = fetch(server, cookie, previous.getString("cursor"));
                    if (!owner.equals(page.getString("owner"))) throw new IllegalStateException("Session changed");
                    events = page.getJSONArray("events");
                    cursor = page.getString("cursor");
                } else seen.clear(); // First connection establishes a baseline; old mail does not notify.
                JSONArray fresh = new JSONArray();
                for (int i = 0; i < Math.min(100, events.length()); i++) {
                    JSONObject event = events.getJSONObject(i);
                    String id = event.getString("id");
                    UrlPolicy.notificationPath(event.getString("threadId"));
                    if (seen.add(id)) fresh.put(event);
                }
                while (seen.size() > 100) seen.remove(seen.iterator().next());
                JSONObject next = new JSONObject().put("server", server).put("owner", owner).put("cursor", cursor).put("seen", new JSONArray(seen));
                main.post(() -> {
                    if (worker != current) return;
                    try {
                        String latestCookie = CookieManager.getInstance().getCookie(server + "/api/desktop/events");
                        if (preferences.getBoolean("notifications", false) && generation == preferences.getInt("generation", 0)
                                && server.equals(preferences.getString("server", "")) && cookie.equals(latestCookie)) {
                            for (int i = 0; i < fresh.length(); i++) show(server, generation, fresh.getJSONObject(i));
                            preferences.edit().putString("notificationState", next.toString()).apply();
                        }
                    } catch (Exception ignored) { /* Permission or session may change while polling. */ }
                    worker = null;
                    jobFinished(parameters, false);
                });
            } catch (Exception ignored) {
                main.post(() -> { if (worker == current) { worker = null; jobFinished(parameters, true); } });
            }
        }, "zero-mail-notifications");
        worker = task;
        task.start();
        return true;
    }
    private JSONObject fetch(String server, String cookie, String after) throws Exception {
        String url = server + "/api/desktop/events" + (after == null ? "" : "?after=" + after);
        JSONObject body = new JSONObject(new String(ServerRequest.get(url, cookie, 1024 * 1024), StandardCharsets.UTF_8));
        if (body.getString("owner").isEmpty() || !body.getString("cursor").matches("[0-9]{1,30}") || body.getJSONArray("events").length() > 100)
            throw new IllegalArgumentException("Invalid event feed");
        return body;
    }
    private void show(String server, int generation, JSONObject event) throws Exception {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) return;
        String id = event.getString("id");
        Intent open = new Intent(this, MainActivity.class).setAction("com.tippye.zeromail.NOTIFICATION")
                .setData(new android.net.Uri.Builder().scheme("zeromail-internal").authority("notification").appendPath(server).appendPath(String.valueOf(generation)).appendPath(id).build())
                .putExtra("server", server).putExtra("generation", generation).putExtra("threadId", event.getString("threadId"));
        PendingIntent pending = PendingIntent.getActivity(this, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(getString(R.string.notification_body))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setAutoCancel(true).setContentIntent(pending).build();
        manager.notify(id, 0, notification);
    }
    @Override public boolean onStopJob(JobParameters parameters) {
        Thread task = worker;
        worker = null;
        if (task != null) task.interrupt();
        return true;
    }
    @Override public void onDestroy() { if (worker != null) worker.interrupt(); worker = null; super.onDestroy(); }
}
