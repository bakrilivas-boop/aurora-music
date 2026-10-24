package com.aurora.music;

import android.content.Context;
import android.content.Intent;
import android.util.AtomicFile;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

@CapacitorPlugin(name = "AuroraDownloads", permissions = @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"}))
public class AuroraDownloadsPlugin extends Plugin {
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private AtomicBoolean reading;
    private DownloadJobs jobs() { return DownloadJobs.get(getContext()); }
    @PluginMethod public void requestNotifications(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) requestPermissionForAlias("notifications", call, "notificationsResult");
        else call.resolve();
    }
    @PermissionCallback private void notificationsResult(PluginCall call) { call.resolve(); }
    private void start() {
        if (jobs().hasWaiting()) ContextCompat.startForegroundService(getContext(), new Intent(getContext(), MusicDownloadService.class));
    }
    @PluginMethod public void snapshot(PluginCall call) { call.resolve(jobs().snapshot()); }
    @PluginMethod public void resume(PluginCall call) {
        try { start(); call.resolve(); } catch (Exception error) { call.reject("无法启动后台下载，请保持应用在前台后重试", error); }
    }
    @PluginMethod public void configure(PluginCall call) {
        reader.execute(() -> {
            try {
                if (jobs().busy()) throw new IOException("请先完成或取消当前下载，再修改解析设置");
                String endpoint = call.getString("endpoint", DownloadNetwork.DEFAULT_ENDPOINT).trim();
                if (endpoint.length() > 400) throw new IOException("接口地址过长");
                endpoint = DownloadNetwork.safeUrl(endpoint, true).toString();
                jobs().configure(endpoint, call.getBoolean("enabled", true)); call.resolve(jobs().snapshot());
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public synchronized void list(PluginCall call) {
        if (reading != null) { call.reject("正在读取歌单，请稍候"); return; }
        AtomicBoolean cancelled = new AtomicBoolean(); reading = cancelled;
        reader.execute(() -> {
            try { call.resolve(new JSObject(new DownloadNetwork().list(call.getString("url", ""), cancelled::get).toString())); }
            catch (Exception error) { call.reject(cancelled.get() ? "已取消读取" : error.getMessage(), error); }
            finally { synchronized (this) { if (reading == cancelled) reading = null; } }
        });
    }
    @PluginMethod public synchronized void cancelRead(PluginCall call) { if (reading != null) reading.set(true); call.resolve(); }
    @PluginMethod public void enqueue(PluginCall call) {
        try { int count = jobs().enqueue(call.getArray("tracks", new JSArray())); start(); call.resolve(new JSObject().put("added", count)); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        try { jobs().cancel(call.getString("key", "")); call.resolve(jobs().snapshot()); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void retry(PluginCall call) {
        try { jobs().retry(call.getString("key", "")); start(); call.resolve(jobs().snapshot()); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @PluginMethod public void clearFinished(PluginCall call) {
        try { jobs().clearFinished(call.getArray("keys", new JSArray())); call.resolve(jobs().snapshot()); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }
    @Override protected synchronized void handleOnDestroy() { if (reading != null) reading.set(true); reader.shutdown(); }
}

/** Durable task descriptions; progress is memory-only, completed files remain recoverable. */
final class DownloadJobs {
    private static DownloadJobs instance;
    private final AtomicFile file;
    private final LinkedHashMap<String, JSONObject> items = new LinkedHashMap<>();
    private final Set<String> running = new HashSet<>();
    private String endpoint = DownloadNetwork.DEFAULT_ENDPOINT;
    private boolean enabled = true;
    private String storageError;
    private DownloadJobs(Context context) {
        file = new AtomicFile(new File(context.getFilesDir(), "music-downloads.json"));
        if (file.getBaseFile().exists()) try (InputStream in = file.openRead(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192]; int n; while ((n = in.read(b)) != -1) { out.write(b, 0, n); if (out.size() > 4 * 1024 * 1024) throw new IOException("下载记录过大"); }
            JSONObject value = new JSONObject(out.toString("UTF-8"));
            endpoint = DownloadNetwork.safeUrl(value.optString("endpoint", endpoint), false).toString(); enabled = value.optBoolean("enabled", true);
            JSONArray jobs = value.optJSONArray("jobs");
            if (jobs != null) for (int i = 0; i < jobs.length() && i < 1000; i++) {
                JSONObject job = jobs.getJSONObject(i);
                if (Arrays.asList("resolving", "downloading").contains(job.optString("status"))) job.put("status", "waiting").put("bytes", 0).put("message", "上次下载中断，重新开始");
                items.put(job.getString("key"), job);
            }
        } catch (Exception error) { storageError = "下载记录读取失败，已保留原文件，请到应用数据目录备份后处理"; }
    }
    static synchronized DownloadJobs get(Context context) { if (instance == null) instance = new DownloadJobs(context.getApplicationContext()); return instance; }
    synchronized void save() throws Exception {
        if (storageError != null) throw new IOException(storageError);
        JSONObject value = new JSONObject().put("endpoint", endpoint).put("enabled", enabled).put("jobs", new JSONArray(items.values()));
        FileOutputStream out = null;
        try { out = file.startWrite(); out.write(value.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
        catch (Exception error) { if (out != null) file.failWrite(out); throw new IOException("下载记录保存失败，请检查手机剩余空间", error); }
    }
    synchronized JSObject snapshot() {
        try { return new JSObject(new JSONObject().put("endpoint", endpoint).put("enabled", enabled).put("jobs", new JSONArray(items.values())).put("error", storageError == null ? "" : storageError).toString()); }
        catch (Exception error) { return new JSObject().put("error", "无法读取下载队列"); }
    }
    synchronized boolean busy() { return !running.isEmpty() || items.values().stream().anyMatch(j -> Arrays.asList("waiting", "resolving", "downloading").contains(j.optString("status"))); }
    synchronized boolean hasWaiting() { return items.values().stream().anyMatch(j -> "waiting".equals(j.optString("status"))); }
    synchronized String endpoint() { return endpoint; }
    synchronized boolean enabled() { return enabled; }
    synchronized void configure(String endpoint, boolean enabled) throws Exception { this.endpoint = endpoint; this.enabled = enabled; save(); }
    static JSONObject validated(JSONObject row) throws Exception {
        String source = row.optString("source"), id = row.optString("id");
        if (!(source.equals("netease") || source.equals("qq")) || !id.matches(source.equals("netease") ? "[1-9]\\d{0,15}" : "[A-Za-z0-9]{10,20}")) throw new IOException("歌曲来源或编号无效");
        double duration = row.optDouble("duration", 0); if (!Double.isFinite(duration) || duration < 0 || duration > 86400) throw new IOException("歌曲时长无效");
        return new JSONObject().put("source", source).put("id", id).put("key", source + "_" + id).put("title", DownloadNetwork.clean(row.optString("title", "歌曲"))).put("artist", DownloadNetwork.clean(row.optString("artist", "未知歌手"))).put("duration", duration);
    }
    synchronized int enqueue(JSONArray rows) throws Exception {
        if (rows.length() < 1 || rows.length() > 1000 || storageError != null) throw new IOException(storageError == null ? "一次请选择 1 至 1000 首歌曲" : storageError);
        LinkedHashMap<String, JSONObject> batch = new LinkedHashMap<>();
        for (int i = 0; i < rows.length(); i++) { JSONObject row = validated(rows.getJSONObject(i)); if (!items.containsKey(row.getString("key"))) batch.put(row.getString("key"), row.put("status", "waiting").put("bytes", 0).put("total", 0)); }
        if (batch.size() + items.size() > 1000) throw new IOException("下载记录已达到 1000 首上限");
        items.putAll(batch);
        try { save(); } catch (Exception error) { for (String key : batch.keySet()) items.remove(key); throw error; }
        return batch.size();
    }
    synchronized JSONObject claim() throws Exception {
        for (JSONObject job : items.values()) if (job.optString("status").equals("waiting") && !running.contains(job.getString("key"))) { job.put("status", "resolving").put("message", "正在获取音源"); save(); running.add(job.getString("key")); return new JSONObject(job.toString()); }
        return null;
    }
    synchronized boolean cancelled(String key) { JSONObject job = items.get(key); return job == null || job.optString("status").equals("cancelled"); }
    synchronized void release(String key) { running.remove(key); }
    synchronized void update(String key, String status, String message, JSONObject completed) throws Exception {
        JSONObject job = items.get(key); if (job == null || job.optString("status").equals("cancelled")) return;
        job.put("status", status).put("message", message);
        if (completed != null) job.put("file", completed);
        save();
    }
    synchronized void progress(String key, long bytes, long total) throws Exception { JSONObject job = items.get(key); if (job != null) { job.put("bytes", bytes).put("total", total); } }
    synchronized void cancel(String key) throws Exception {
        for (JSONObject job : items.values()) if ((key.isEmpty() || key.equals(job.optString("key"))) && Arrays.asList("waiting", "resolving", "downloading").contains(job.optString("status"))) job.put("status", "cancelled").put("message", "已取消");
        save();
    }
    synchronized void retry(String key) throws Exception {
        if (running.contains(key)) throw new IOException("任务正在取消，请稍后再重试");
        JSONObject job = items.get(key); if (job == null || !Arrays.asList("failed", "cancelled").contains(job.optString("status"))) throw new IOException("只能重试失败或取消的任务");
        job.put("status", "waiting").put("bytes", 0).put("total", 0).put("message", "等待下载"); save();
    }
    synchronized void clearFinished(JSONArray keys) throws Exception {
        if (keys.length() > 1000) throw new IOException("一次最多清理 1000 条记录");
        for (int i = 0; i < keys.length(); i++) {
            String key = keys.getString(i); JSONObject job = items.get(key);
            if (job != null && !running.contains(key) && Arrays.asList("complete", "failed", "cancelled").contains(job.optString("status"))) items.remove(key);
        }
        save();
    }
}
