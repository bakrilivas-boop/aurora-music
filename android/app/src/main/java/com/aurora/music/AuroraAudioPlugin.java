package com.aurora.music;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.PlaybackException;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.*;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.function.Consumer;
import org.json.JSONObject;

@CapacitorPlugin(name = "AuroraAudio")
public class AuroraAudioPlugin extends Plugin {
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private ListenableFuture<MediaController> connection;
    private MediaController controller;
    private String lastError = "";

    private void connected(PluginCall call, Consumer<MediaController> action) {
        getActivity().runOnUiThread(() -> {
            if (connection == null) {
                SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
                connection = new MediaController.Builder(getContext(), token).buildAsync();
            }
            connection.addListener(() -> {
                try {
                    MediaController next = connection.get();
                    if (controller != next) {
                        controller = next;
                        controller.addListener(new Player.Listener() {
                            @Override public void onEvents(Player player, Player.Events events) { notifyListeners("playback", snapshot()); }
                            @Override public void onPlayerError(PlaybackException error) {
                                lastError = "当前歌曲无法播放，请检查音频格式或重新导入";
                                notifyListeners("playback", snapshot());
                            }
                        });
                    }
                    action.accept(controller);
                } catch (Exception error) { call.reject("系统播放器连接失败，请重新打开应用", error); }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    private JSObject snapshot() {
        JSObject out = new JSObject();
        MediaItem item = controller == null ? null : controller.getCurrentMediaItem();
        out.put("id", item == null ? "" : item.mediaId);
        out.put("playing", controller != null && controller.isPlaying());
        out.put("position", controller == null ? 0 : controller.getCurrentPosition() / 1000.0);
        out.put("duration", controller == null ? 0 : Math.max(0, controller.getDuration()) / 1000.0);
        JSArray queue = new JSArray();
        if (controller != null) for (int i = 0; i < controller.getMediaItemCount(); i++) queue.put(controller.getMediaItemAt(i).mediaId);
        out.put("queue", queue);
        if (!lastError.isEmpty()) { out.put("error", lastError); lastError = ""; }
        return out;
    }

    @PluginMethod public void state(PluginCall call) { connected(call, player -> call.resolve(snapshot())); }

    private int repeat(String value) {
        return "one".equals(value) ? Player.REPEAT_MODE_ONE : "all".equals(value) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF;
    }

    @PluginMethod public void queue(PluginCall call) {
        connected(call, player -> {
            try {
                JSArray raw = call.getArray("items", new JSArray());
                List<MediaItem> items = new ArrayList<>();
                for (int i = 0; i < raw.length(); i++) {
                    JSONObject item = raw.getJSONObject(i);
                    File audio = privateFile(item.getString("uri"));
                    MediaMetadata.Builder meta = new MediaMetadata.Builder().setTitle(item.optString("title"))
                        .setArtist(item.optString("artist")).setIsPlayable(true);
                    if (!item.optString("artwork").isEmpty()) meta.setArtworkUri(Uri.fromFile(privateFile(item.getString("artwork"))));
                    items.add(new MediaItem.Builder().setMediaId(item.getString("id")).setUri(Uri.fromFile(audio)).setMediaMetadata(meta.build()).build());
                }
                if (items.isEmpty()) { call.reject("播放队列为空"); return; }
                int index = Math.max(0, Math.min(items.size() - 1, call.getInt("index", 0)));
                player.setRepeatMode(repeat(call.getString("repeat", "all")));
                player.setVolume(call.getFloat("volume", 0.8f));
                player.setMediaItems(items, index, Math.max(0, Math.round(call.getDouble("position", 0.0) * 1000)));
                player.prepare();
                player.setPlayWhenReady(call.getBoolean("play", true));
                call.resolve();
            } catch (Exception error) { call.reject("歌曲文件不可读，请重新导入", error); }
        });
    }

    @PluginMethod public void control(PluginCall call) {
        connected(call, player -> {
            switch (call.getString("action", "")) {
                case "play": if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0); player.play(); break;
                case "pause": player.pause(); break;
                case "clear": player.clearMediaItems(); player.stop(); break;
                case "seek": player.seekTo(Math.max(0, Math.round(call.getDouble("value", 0.0) * 1000))); break;
                case "volume": player.setVolume(Math.max(0, Math.min(1, call.getFloat("value", 0.8f)))); break;
                case "repeat": player.setRepeatMode(repeat(call.getString("value", "all"))); break;
                default: call.reject("未知播放操作"); return;
            }
            call.resolve();
        });
    }

    private File musicDir() {
        File dir = new File(getContext().getFilesDir(), "music");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("无法创建应用音乐目录");
        return dir;
    }

    private File privateFile(String uri) throws IOException {
        Uri parsed = Uri.parse(uri);
        if (!"file".equals(parsed.getScheme())) throw new IOException("只允许应用内歌曲");
        File f = new File(parsed.getPath()).getCanonicalFile();
        if (!f.getPath().startsWith(musicDir().getCanonicalPath() + File.separator)) throw new IOException("文件位于音乐目录外");
        return f;
    }

    @PluginMethod public void readRange(PluginCall call) {
        files.execute(() -> {
            try {
                File f = privateFile(call.getString("uri", ""));
                long start = call.getLong("start", 0L);
                int length = call.getInt("length", 0);
                if (start < 0 || start > f.length() || length < 0 || length > 32 * 1024 * 1024) throw new IOException("标签大小无效");
                byte[] bytes = new byte[(int)Math.min(length, f.length() - start)];
                try (RandomAccessFile in = new RandomAccessFile(f, "r")) { in.seek(start); in.readFully(bytes); }
                JSObject out = new JSObject(); out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)); call.resolve(out);
            } catch (Exception error) { call.reject("无法读取歌曲标签", error); }
        });
    }

    @PluginMethod public void artwork(PluginCall call) {
        files.execute(() -> {
            try {
                String id = call.getString("id", "");
                if (!id.matches("[a-f0-9]{64}")) throw new IOException("封面编号无效");
                String raw = call.getString("data", "");
                if (raw.length() > 24 * 1024 * 1024) throw new IOException("封面过大");
                String mime = call.getString("mime", "image/jpeg");
                File out = new File(musicDir(), id + (mime.contains("png") ? ".cover.png" : mime.contains("webp") ? ".cover.webp" : ".cover.jpg"));
                try (FileOutputStream stream = new FileOutputStream(out)) { stream.write(Base64.decode(raw, Base64.DEFAULT)); }
                JSObject result = new JSObject(); result.put("uri", Uri.fromFile(out).toString()); call.resolve(result);
            } catch (Exception error) { call.reject("封面保存失败", error); }
        });
    }

    @PluginMethod public void pick(PluginCall call) {
        boolean folder = call.getBoolean("folder", false);
        Intent intent = new Intent(folder ? Intent.ACTION_OPEN_DOCUMENT_TREE : Intent.ACTION_OPEN_DOCUMENT);
        if (!folder) {
            intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/ogg", "text/plain", "application/x-subrip", "image/*"});
        }
        startActivityForResult(call, intent, "picked");
    }

    private boolean supported(String name) {
        return name.toLowerCase(Locale.ROOT).matches(".*\\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|ape|m4b|mp4|aiff|aif|alac|lrc|txt|jpg|jpeg|png|webp)$");
    }
    private static class Selected {
        Uri uri; String name; String relative;
        Selected(Uri uri, String name, String relative) { this.uri = uri; this.name = name; this.relative = relative; }
    }
    private void walk(Uri tree, String id, String prefix, int depth, List<Selected> selected) throws Exception {
        if (depth > 32) return;
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id);
        try (Cursor cursor = getContext().getContentResolver().query(children, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String childId = cursor.getString(0), name = cursor.getString(1), type = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(type)) walk(tree, childId, prefix + name + "/", depth + 1, selected);
                else if (supported(name)) selected.add(new Selected(DocumentsContract.buildDocumentUriUsingTree(tree, childId), name, prefix + name));
            }
        }
    }

    @ActivityCallback private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject out = new JSObject(); out.put("cancelled", true); out.put("files", new JSArray()); call.resolve(out); return;
        }
        files.execute(() -> {
            try {
                List<Selected> selected = new ArrayList<>();
                if (call.getBoolean("folder", false)) {
                    Uri tree = data.getData(); walk(tree, DocumentsContract.getTreeDocumentId(tree), "", 0, selected);
                } else {
                    List<Uri> uris = new ArrayList<>();
                    if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
                    else if (data.getData() != null) uris.add(data.getData());
                    for (Uri uri : uris) try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst() && supported(cursor.getString(0))) selected.add(new Selected(uri, cursor.getString(0), cursor.getString(0)));
                    }
                }
                JSArray imported = new JSArray(); int failed = 0;
                for (Selected item : selected) {
                    File pending = File.createTempFile("import-", ".part", musicDir());
                    try {
                        MessageDigest digest = MessageDigest.getInstance("SHA-256");
                        try (InputStream in = getContext().getContentResolver().openInputStream(item.uri); OutputStream out = new FileOutputStream(pending)) {
                            if (in == null) throw new IOException("文件不可读");
                            byte[] buffer = new byte[65536]; int count;
                            while ((count = in.read(buffer)) != -1) { out.write(buffer, 0, count); digest.update(buffer, 0, count); }
                        }
                        StringBuilder hash = new StringBuilder();
                        for (byte b : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", b & 255));
                        String extension = item.name.substring(item.name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                        File target = new File(musicDir(), hash + "." + extension);
                        if (!target.exists() && !pending.renameTo(target)) throw new IOException("无法保存歌曲");
                        JSObject file = new JSObject(); file.put("id", hash.toString()); file.put("name", item.name);
                        file.put("relative", item.relative); file.put("size", target.length()); file.put("uri", Uri.fromFile(target).toString()); imported.put(file);
                    } catch (Exception error) { failed++; }
                    finally { if (pending.exists()) pending.delete(); }
                }
                JSObject out = new JSObject(); out.put("files", imported); out.put("failed", failed); call.resolve(out);
            } catch (Exception error) { call.reject("文件夹读取失败，请选择手机本地的音乐目录", error); }
        });
    }

    @Override protected void handleOnDestroy() {
        if (connection != null) MediaController.releaseFuture(connection);
        files.shutdown();
    }
}
