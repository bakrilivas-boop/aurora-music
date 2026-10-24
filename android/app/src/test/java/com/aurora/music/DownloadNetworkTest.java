package com.aurora.music;

import static org.junit.Assert.*;
import org.junit.Test;
import org.json.*;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

public class DownloadNetworkTest {
    private JSONObject song(long id) throws Exception { return new JSONObject().put("id", id).put("name", "歌曲" + id).put("dt", 60000).put("fee", 0).put("ar", new JSONArray().put(new JSONObject().put("name", "歌手"))); }
    private JSONObject permission(long id) throws Exception { return new JSONObject().put("id", id).put("dl", 128000).put("st", 0).put("cp", 1); }
    @Test public void linksAreRestrictedToRealPlaylistHostsAndIds() throws Exception {
        assertEquals("123", DownloadNetwork.parsePlaylist("https://music.163.com/#/playlist?id=123").getString("playlistId"));
        assertEquals("qq", DownloadNetwork.parsePlaylist("https://y.qq.com/n/ryqq/playlist/123").getString("source"));
        for (String url : new String[]{"https://evil.example/playlist?id=123", "https://music.163.com/song?id=123", "https://a@music.163.com/playlist?id=123", "file:///playlist?id=123", "https://music.163.com:443/playlist?id=123"}) {
            try { DownloadNetwork.parsePlaylist(url); fail(url); } catch (IOException expected) {}
        }
    }
    @Test public void fillsMissingNeteaseSongsAndMarksIncompleteLists() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        DownloadNetwork network = new DownloadNetwork((url, cancelled) -> {
            calls.incrementAndGet();
            if (url.contains("playlist/detail")) return new JSONObject().put("code", 200).put("playlist", new JSONObject().put("name", "测试歌单").put("trackCount", 2).put("tracks", new JSONArray().put(song(1))).put("trackIds", new JSONArray().put(new JSONObject().put("id", 1)).put(new JSONObject().put("id", 2)))).put("privileges", new JSONArray().put(permission(1)));
            return new JSONObject().put("code", 200).put("songs", new JSONArray().put(song(2))).put("privileges", new JSONArray().put(permission(2)));
        });
        JSONObject result = network.list("https://music.163.com/m/playlist?id=123", () -> false);
        assertEquals(2, result.getJSONArray("tracks").length()); assertTrue(result.getBoolean("complete")); assertEquals(2, calls.get());
        assertFalse(result.getJSONArray("tracks").getJSONObject(0).getBoolean("restricted"));
    }
    @Test public void missingPrivilegesRemainRestricted() throws Exception {
        assertTrue(DownloadNetwork.song(song(1), "netease", null).getBoolean("restricted"));
        assertFalse(DownloadNetwork.song(song(1), "netease", permission(1)).getBoolean("restricted"));
    }
    @Test public void qqPlaylistReadsBooleanPaginationAndPermissionFlags() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        DownloadNetwork network = new DownloadNetwork((url, cancelled) -> {
            int index = calls.incrementAndGet();
            JSONObject track = new JSONObject().put("mid", "abcdefghijk" + index).put("title", "QQ Song " + index).put("interval", 60)
                .put("singer", new JSONArray().put(new JSONObject().put("name", "Singer"))).put("pay", new JSONObject().put("pay_down", 0).put("pay_play", 0));
            JSONObject page = new JSONObject().put("hasmore", index == 1).put("total_song_num", 2).put("songlist", new JSONArray().put(track));
            return new JSONObject().put("code", 0).put("req_0", new JSONObject().put("code", 0).put("data", page));
        });
        JSONObject result = network.list("https://y.qq.com/n/ryqq/playlist/123", () -> false);
        assertEquals(2, calls.get()); assertEquals(2, result.getJSONArray("tracks").length()); assertTrue(result.getBoolean("complete"));
        assertFalse(result.getJSONArray("tracks").getJSONObject(0).getBoolean("restricted"));
    }
    @Test public void onlyVerifiedFullOfficialAudioIsUsed() throws Exception {
        DownloadNetwork network = new DownloadNetwork((url, cancelled) -> url.contains("song/detail")
            ? new JSONObject().put("code", 200).put("songs", new JSONArray().put(song(1))).put("privileges", new JSONArray().put(permission(1)))
            : new JSONObject().put("code", 200).put("data", new JSONArray().put(new JSONObject().put("id", 1).put("code", 200).put("fee", 0).put("time", 60000).put("url", "https://m701.music.126.net/track.mp3"))));
        JSONObject result = network.resolve(new JSONObject().put("id", "1").put("source", "netease"), DownloadNetwork.DEFAULT_ENDPOINT, false, () -> false);
        assertFalse(result.getBoolean("mirrored")); assertEquals("mp3", result.getString("extension"));
    }
    @Test public void restrictedSongsCannotBeForcedThroughOfficialUrlByInput() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        DownloadNetwork network = new DownloadNetwork((url, cancelled) -> { calls.incrementAndGet(); return new JSONObject().put("code", 200).put("songs", new JSONArray().put(song(1).put("fee", 1))).put("privileges", new JSONArray().put(permission(1))); });
        try { network.resolve(new JSONObject().put("id", "1").put("source", "netease").put("restricted", false), DownloadNetwork.DEFAULT_ENDPOINT, false, () -> false); fail(); } catch (IOException expected) {}
        assertEquals(1, calls.get());
    }
    @Test public void mirrorKeepsDurationAndHttpsChecks() throws Exception {
        DownloadNetwork network = new DownloadNetwork((url, cancelled) -> { if (url.contains("song/detail")) throw new IOException("平台不可用"); return new JSONObject().put("url", "https://cdn.example/audio.mp3").put("br", 320).put("size", 2400000); });
        JSONObject track = new JSONObject().put("id", "1").put("source", "netease").put("duration", 60);
        assertTrue(network.resolve(track, DownloadNetwork.DEFAULT_ENDPOINT, true, () -> false).getBoolean("mirrored"));
        track.put("duration", 180);
        try { network.resolve(track, DownloadNetwork.DEFAULT_ENDPOINT, true, () -> false); fail(); } catch (IOException expected) { assertTrue(expected.getMessage().contains("时长")); }
        for (String url : new String[]{"http://example.com/a.mp3", "https://127.0.0.1/a.mp3", "https://10.0.0.1/a.mp3", "https://user:pass@example.com/a.mp3"}) {
            try { DownloadNetwork.safeUrl(url, true); fail(url); } catch (IOException expected) {}
        }
    }
    @Test public void validatesFileMagicAndBatchInputs() throws Exception {
        assertFalse(DownloadNetwork.audioHeader("<html>an error page</html>".getBytes("UTF-8")));
        assertTrue(DownloadNetwork.audioHeader("ID301234567890123".getBytes("UTF-8")));
        assertEquals("netease_123", DownloadJobs.validated(new JSONObject().put("source", "netease").put("id", "123")).getString("key"));
        try { DownloadJobs.validated(new JSONObject().put("source", "netease").put("id", "../secret")); fail(); } catch (IOException expected) {}
    }
}
