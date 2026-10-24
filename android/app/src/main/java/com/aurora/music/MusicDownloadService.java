package com.aurora.music;

import android.app.*;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.*;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.*;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** Native queue and two streaming workers keep running independently of the UI. */
public class MusicDownloadService extends Service {
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final Handler main = new Handler(Looper.getMainLooper());
    private DownloadJobs jobs;
    private volatile boolean stopping;
    private PowerManager.WakeLock wake;
    private boolean pumping;

    @Override public void onCreate() {
        super.onCreate(); jobs = DownloadJobs.get(this);
        NotificationManager manager = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel("music-downloads", "歌曲下载", NotificationManager.IMPORTANCE_LOW));
    }
    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 41, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent cancel = new Intent(this, MusicDownloadService.class).setAction("cancel");
        PendingIntent stop = PendingIntent.getService(this, 42, cancel, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, "music-downloads").setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Aurora Music · 歌曲下载")
            .setContentText("下载完成后自动加入音乐库，点击返回应用查看进度").setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消全部", stop).setPriority(NotificationCompat.PRIORITY_LOW).build();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "cancel".equals(intent.getAction())) { try { jobs.cancel(""); } catch (Exception ignored) {} }
        ServiceCompat.startForeground(this, 42, notification(), Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0);
        if (wake == null) {
            PowerManager power = (PowerManager)getSystemService(POWER_SERVICE);
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuroraMusic:downloads"); wake.acquire(6 * 60 * 60 * 1000L);
        }
        pump(); return START_NOT_STICKY;
    }
    private void pump() {
        if (stopping || pumping) return;
        pumping = true;
        try {
            while (active.size() < 2) {
                JSONObject task = jobs.claim(); if (task == null) break;
                String key = task.getString("key"); active.add(key);
                workers.execute(() -> {
                    try { download(task); }
                    catch (Exception error) { try { jobs.update(key, "failed", message(error), null); } catch (Exception ignored) {} }
                    finally { jobs.release(key); active.remove(key); main.post(this::pump); }
                });
            }
            if (active.isEmpty() && !jobs.hasWaiting()) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
        } catch (Exception error) { try { jobs.cancel(""); } catch (Exception ignored) {} stopSelf(); }
        finally { pumping = false; }
    }
    static String message(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "网络连接超时，请重试";
        String text = error.getMessage(); return text == null || text.isEmpty() ? "下载失败，请检查网络后重试" : text.substring(0, Math.min(180, text.length()));
    }
    private void download(JSONObject task) throws Exception {
        String key = task.getString("key"); BooleanSupplier cancelled = () -> stopping || jobs.cancelled(key);
        JSONObject result = new DownloadNetwork().resolve(task, jobs.endpoint(), jobs.enabled(), cancelled);
        DownloadNetwork.checkCancelled(cancelled);
        File directory = new File(getFilesDir(), "music"); if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建音乐目录");
        File pending = File.createTempFile("download-", ".part", directory);
        HttpURLConnection connection = null;
        try {
            connection = DownloadNetwork.connection(result.getString("url"), cancelled);
            long total = connection.getContentLengthLong(), count = 0, last = 0, deadline = System.currentTimeMillis() + 2 * 60 * 60 * 1000L;
            if (total > DownloadNetwork.MAX_AUDIO) throw new IOException("歌曲超过 200 MiB 下载上限");
            String mime = connection.getContentType();
            if (mime != null && (mime.contains("text/") || mime.contains("json") || mime.contains("html"))) throw new IOException("接口返回了网页或错误信息，并非音乐文件");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            jobs.update(key, "downloading", result.optBoolean("mirrored") ? "正在从备用音源下载" : "正在下载", null);
            try (InputStream in = new BufferedInputStream(connection.getInputStream()); FileOutputStream out = new FileOutputStream(pending)) {
                byte[] header = new byte[16]; int head = 0, n;
                while (head < header.length && (n = in.read(header, head, header.length - head)) != -1) { DownloadNetwork.checkCancelled(cancelled); head += n; }
                if (head < 16 || !DownloadNetwork.audioHeader(header)) throw new IOException("返回内容不是支持的音乐格式");
                out.write(header); digest.update(header); count = header.length;
                byte[] bytes = new byte[65536];
                while ((n = in.read(bytes)) != -1) {
                    DownloadNetwork.checkCancelled(cancelled); count += n;
                    if (count > DownloadNetwork.MAX_AUDIO || System.currentTimeMillis() > deadline) throw new IOException("下载超过大小或时间限制");
                    out.write(bytes, 0, n); digest.update(bytes, 0, n);
                    if (System.currentTimeMillis() - last > 300) { jobs.progress(key, count, total); last = System.currentTimeMillis(); }
                }
                out.getFD().sync();
            }
            DownloadNetwork.checkCancelled(cancelled);
            if (count < 16 || total > 0 && count != total) throw new IOException("下载文件不完整，请重试");
            double duration;
            MediaMetadataRetriever reader = new MediaMetadataRetriever();
            try {
                reader.setDataSource(pending.getAbsolutePath()); String raw = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                duration = raw == null ? 0 : Double.parseDouble(raw) / 1000;
            } finally { reader.release(); }
            double expected = task.optDouble("duration", 0);
            if (duration <= 0 || expected > 0 && Math.abs(duration - expected) > Math.max(5, expected * .05)) throw new IOException("音频时长与歌曲不符，可能仅是试听片段，已跳过");
            StringBuilder hash = new StringBuilder(); for (byte b : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", b & 255));
            String extension = result.getString("extension"); File target = new File(directory, hash + "." + extension);
            DownloadNetwork.checkCancelled(cancelled);
            String filename = (task.optString("artist") + " - " + task.optString("title")).replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_");
            filename = filename.substring(0, Math.min(150, filename.length())) + "." + extension;
            JSONObject file = new JSONObject().put("id", hash.toString()).put("name", filename).put("relative", "下载的音乐/" + filename).put("uri", Uri.fromFile(target).toString()).put("size", target.length()).put("duration", duration);
            synchronized (jobs) {
                DownloadNetwork.checkCancelled(cancelled);
                if (!target.exists() && !pending.renameTo(target)) throw new IOException("保存歌曲失败，请检查剩余空间");
                file.put("size", target.length());
                jobs.progress(key, count, count); jobs.update(key, "complete", "已下载，自动加入曲库", file);
            }
        } finally { if (connection != null) connection.disconnect(); if (pending.exists()) pending.delete(); }
    }
    @Override public void onTimeout(int startId, int fgsType) { stopping = true; try { jobs.cancel(""); } catch (Exception ignored) {} stopSelf(); }
    @Override public void onDestroy() { stopping = true; workers.shutdownNow(); main.removeCallbacksAndMessages(null); if (wake != null && wake.isHeld()) wake.release(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
