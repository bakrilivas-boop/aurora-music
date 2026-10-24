package com.aurora.music;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.BooleanSupplier;
import org.json.*;

/** Public playlist APIs, using the same contracts as electron/playlist-sources.cjs. */
final class DownloadNetwork {
    static final String DEFAULT_ENDPOINT = "https://music-api.gdstudio.xyz/api.php";
    static final long MAX_AUDIO = 200L * 1024 * 1024;
    interface JsonRequest { JSONObject get(String url, BooleanSupplier cancelled) throws Exception; }
    final JsonRequest request;
    DownloadNetwork() { this(DownloadNetwork::json); }
    DownloadNetwork(JsonRequest request) { this.request = request; }

    static String encoded(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
    static void checkCancelled(BooleanSupplier cancelled) throws IOException {
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("已取消");
    }
    static URL safeUrl(String input, boolean resolve) throws Exception {
        URL u = new URL(input);
        String host = u.getHost().toLowerCase(Locale.ROOT);
        if (!u.getProtocol().equals("https") || u.getUserInfo() != null || u.getPort() != -1 || host.isEmpty() || host.contains(":") ||
            host.equals("localhost") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new IOException("地址必须是公网 HTTPS 地址");
        if (resolve) for (InetAddress address : InetAddress.getAllByName(host)) {
            byte[] b = address.getAddress();
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress() ||
                (b.length == 4 && ((b[0] & 255) == 0 || ((b[0] & 255) == 100 && (b[1] & 255) >= 64 && (b[1] & 255) <= 127))) ||
                (b.length == 16 && ((b[0] & 254) == 252))) throw new IOException("不允许访问本地或内网地址");
        }
        return u.getRef() == null ? u : new URL(u.toString().substring(0, u.toString().indexOf('#')));
    }
    static HttpURLConnection connection(String input, BooleanSupplier cancelled) throws Exception {
        URL url = safeUrl(input, true);
        for (int hop = 0; hop < 6; hop++) {
            checkCancelled(cancelled);
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            try {
                c.setInstanceFollowRedirects(false); c.setConnectTimeout(10000); c.setReadTimeout(15000);
                c.setRequestProperty("User-Agent", "AuroraMusic-Android/1.1");
                String host = url.getHost().toLowerCase(Locale.ROOT);
                if (host.endsWith("163.com") || host.endsWith("music.126.net")) c.setRequestProperty("Referer", "https://music.163.com/");
                else if (host.endsWith("qq.com")) c.setRequestProperty("Referer", "https://y.qq.com/");
                c.setRequestProperty("Accept-Encoding", "identity");
                int code = c.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = c.getHeaderField("Location");
                    if (location == null) throw new IOException("接口返回无效跳转");
                    url = safeUrl(new URL(url, location).toString(), true); c.disconnect(); continue;
                }
                if (code != 200) throw new IOException("接口返回 HTTP " + code + "，请稍后重试");
                return c;
            } catch (Exception error) { c.disconnect(); throw error; }
        }
        throw new IOException("接口跳转次数过多");
    }
    static JSONObject json(String url, BooleanSupplier cancelled) throws Exception {
        HttpURLConnection c = connection(url, cancelled);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (c.getContentLengthLong() > 2 * 1024 * 1024) throw new IOException("接口资料过大");
            byte[] bytes = new byte[16384]; int n;
            while ((n = in.read(bytes)) != -1) { checkCancelled(cancelled); out.write(bytes, 0, n); if (out.size() > 2 * 1024 * 1024) throw new IOException("接口资料过大"); }
            String raw = out.toString("UTF-8").trim();
            if (raw.startsWith("https://")) return new JSONObject().put("url", raw);
            if (raw.startsWith("[")) return new JSONArray(raw).getJSONObject(0);
            return new JSONObject(raw);
        } finally { c.disconnect(); }
    }
    static String clean(String value) { return value == null ? "" : value.trim().substring(0, Math.min(value.trim().length(), 200)); }
    static JSONObject parsePlaylist(String input) throws Exception {
        if (input == null || input.length() > 2000) throw new IOException("请粘贴完整歌单链接");
        URI u = new URI(input.trim()); String host = u.getHost();
        if (host == null || u.getUserInfo() != null || u.getPort() != -1 || !("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) throw new IOException("歌单链接无效");
        String source, id = null;
        if (host.equals("music.163.com") || host.equals("y.music.163.com")) {
            source = "netease";
            if (u.getFragment() != null && u.getFragment().startsWith("/")) u = new URI("https://music.163.com" + u.getFragment());
            if (!u.getPath().matches("/(m/)?playlist/?")) throw new IOException("请使用网易云歌单链接");
            id = query(u, "id");
        } else if (host.equals("y.qq.com") || host.equals("i.y.qq.com")) {
            source = "qq";
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("/n/(?:ryqq|yqq)/playlist/(\\d+)(?:\\.html)?/?").matcher(u.getPath());
            if (m.matches()) id = m.group(1);
            else if (u.getPath().matches("/n/(ryqq|yqq)/playlist/?") || u.getPath().matches(".*/taoge(/index)?\\.html")) { id = query(u, "disstid"); if (id == null) id = query(u, "id"); }
        } else throw new IOException("只支持网易云和 QQ 音乐歌单");
        if (id == null || !id.matches("[1-9]\\d{0,15}") || Long.parseLong(id) > 9007199254740991L) throw new IOException("歌单编号无效，请复制完整链接");
        return new JSONObject().put("source", source).put("playlistId", id);
    }
    static String query(URI u, String key) throws Exception {
        if (u.getRawQuery() != null) for (String part : u.getRawQuery().split("&")) { String[] pair = part.split("=", 2); if (URLDecoder.decode(pair[0], "UTF-8").equals(key)) return pair.length > 1 ? URLDecoder.decode(pair[1], "UTF-8") : ""; }
        return null;
    }
    static JSONObject song(JSONObject s, String source, JSONObject privilege) throws Exception {
        boolean netease = source.equals("netease"); String id = netease ? s.optString("id") : s.optString("mid", s.optString("songmid"));
        if (!id.matches(netease ? "[1-9]\\d{0,15}" : "[a-zA-Z0-9]{10,20}")) return null;
        JSONArray artists = s.optJSONArray(netease ? "ar" : "singer"); if (artists == null) artists = s.optJSONArray("artists");
        List<String> names = new ArrayList<>();
        if (artists != null) for (int i = 0; i < artists.length(); i++) names.add(clean(artists.getJSONObject(i).optString("name")));
        StringBuilder joined = new StringBuilder(); for (String name : names) { if (joined.length() > 0) joined.append("、"); joined.append(name); }
        JSONObject pay = s.optJSONObject("pay");
        boolean restricted = netease ? s.optInt("fee", privilege == null ? 0 : privilege.optInt("fee")) != 0 || privilege == null || privilege.optInt("dl") <= 0 || privilege.optInt("st") < 0 || privilege.optInt("cp", 1) == 0 :
            pay == null || pay.optInt("pay_down") != 0 || pay.optInt("pay_play") != 0;
        return new JSONObject().put("id", id).put("source", source).put("title", clean(s.optString("title", s.optString("name", s.optString("songname", "未命名歌曲")))))
            .put("artist", names.isEmpty() ? "未知歌手" : clean(joined.toString())).put("duration", netease ? s.optDouble("dt", s.optDouble("duration", 0)) / 1000 : s.optDouble("interval", 0)).put("restricted", restricted);
    }
    JSONObject musicu(String module, String method, JSONObject param, BooleanSupplier cancelled) throws Exception {
        JSONObject payload = new JSONObject().put("comm", new JSONObject().put("uin", 0).put("format", "json").put("ct", 24).put("cv", 0)).put("req_0", new JSONObject().put("module", module).put("method", method).put("param", param));
        JSONObject response = request.get("https://u.y.qq.com/cgi-bin/musicu.fcg?data=" + encoded(payload.toString()), cancelled);
        JSONObject row = response.optJSONObject("req_0");
        if (response.optInt("code", -1) != 0 || row == null || row.optInt("code", -1) != 0 || row.optJSONObject("data") == null) throw new IOException("QQ 音乐暂时无法读取，请确认歌单公开或稍后重试");
        return row.getJSONObject("data");
    }
    JSONObject list(String input, BooleanSupplier cancelled) throws Exception {
        JSONObject parsed = parsePlaylist(input); String source = parsed.getString("source"), id = parsed.getString("playlistId"), name = "歌单";
        LinkedHashMap<String, JSONObject> found = new LinkedHashMap<>(); int total = 0; boolean complete = false;
        if (source.equals("netease")) {
            JSONObject response = request.get("https://music.163.com/api/v6/playlist/detail?id=" + id + "&n=1000&s=0", cancelled);
            if (response.optInt("code") != 200 || response.optJSONObject("playlist") == null) throw new IOException("网易云暂时无法读取，请确认歌单公开或稍后重试");
            JSONObject p = response.getJSONObject("playlist"); name = clean(p.optString("name", "网易云歌单"));
            JSONArray ids = p.optJSONArray("trackIds"), rows = p.optJSONArray("tracks"); total = Math.max(p.optInt("trackCount"), ids == null ? 0 : ids.length());
            addSongs(found, rows, response.optJSONArray("privileges"), source);
            List<String> missing = new ArrayList<>(); if (ids != null) for (int i = 0; i < ids.length() && missing.size() + found.size() < 1000; i++) { String next = ids.getJSONObject(i).optString("id"); if (next.matches("[1-9]\\d{0,15}") && !found.containsKey(next)) missing.add(next); }
            for (int start = 0, calls = 1; start < missing.size() && calls < 10; start += 100, calls++) {
                JSONArray batch = new JSONArray(); for (String next : missing.subList(start, Math.min(missing.size(), start + 100))) batch.put(new JSONObject().put("id", Long.parseLong(next)));
                JSONObject page = request.get("https://music.163.com/api/v3/song/detail?c=" + encoded(batch.toString()), cancelled);
                if (page.optInt("code") != 200) break;
                addSongs(found, page.optJSONArray("songs"), page.optJSONArray("privileges"), source);
            }
            complete = found.size() == total;
        } else {
            int start = 0;
            for (int calls = 0; calls < 10 && found.size() < 1000; calls++) {
                JSONObject page = musicu("music.srfDissInfo.aiDissInfo", "uniform_get_Dissinfo", new JSONObject().put("disstid", Long.parseLong(id)).put("song_begin", start).put("song_num", Math.min(100, 1000 - found.size())), cancelled);
                JSONObject dir = page.optJSONObject("dirinfo"); if (dir != null) name = clean(dir.optString("title", "QQ 音乐歌单"));
                total = Math.max(total, page.optInt("total_song_num", dir == null ? 0 : dir.optInt("songnum")));
                JSONArray rows = page.optJSONArray("songlist"); int before = found.size(); addSongs(found, rows, null, source);
                start += rows == null ? 0 : rows.length();
                boolean more = page.optBoolean("hasmore", page.optInt("hasmore") != 0);
                if (!more || rows == null || rows.length() == 0 || found.size() == before) { complete = total > 0 ? found.size() == total : !more; break; }
            }
            if (total == found.size()) complete = true;
        }
        if (total == 0 && complete) total = found.size();
        return parsed.put("name", name).put("tracks", new JSONArray(found.values())).put("total", total).put("complete", complete);
    }
    static void addSongs(Map<String, JSONObject> found, JSONArray rows, JSONArray permissions, String source) throws Exception {
        Map<String, JSONObject> privileges = new HashMap<>(); if (permissions != null) for (int i = 0; i < permissions.length(); i++) privileges.put(permissions.getJSONObject(i).optString("id"), permissions.getJSONObject(i));
        if (rows != null) for (int i = 0; i < rows.length() && found.size() < 1000; i++) { JSONObject s = rows.getJSONObject(i); JSONObject item = song(s, source, privileges.get(s.optString("id"))); if (item != null) found.put(item.getString("id"), item); }
    }
    JSONObject official(JSONObject input, BooleanSupplier cancelled) throws Exception {
        String id = input.getString("id"), source = input.getString("source");
        if (source.equals("netease")) {
            JSONObject response = request.get("https://music.163.com/api/v3/song/detail?c=" + encoded(new JSONArray().put(new JSONObject().put("id", Long.parseLong(id))).toString()), cancelled);
            JSONArray songs = response.optJSONArray("songs"), ps = response.optJSONArray("privileges"); JSONObject track = null;
            if (songs != null) for (int i = 0; i < songs.length(); i++) if (id.equals(songs.getJSONObject(i).optString("id"))) { JSONObject privilege = null; if (ps != null) for (int j = 0; j < ps.length(); j++) if (id.equals(ps.getJSONObject(j).optString("id"))) privilege = ps.getJSONObject(j); track = song(songs.getJSONObject(i), source, privilege); }
            if (track == null || track.getBoolean("restricted")) throw new IOException("平台未提供公开下载权限");
            JSONObject result = request.get("https://music.163.com/api/song/enhance/player/url?ids=" + encoded("[" + id + "]") + "&br=128000", cancelled);
            JSONArray rows = result.optJSONArray("data");
            if (rows != null) for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.getJSONObject(i); if (id.equals(row.optString("id")) && row.optInt("code") == 200 && row.optInt("fee") == 0 && row.isNull("freeTrialInfo") && row.optLong("time") > 0 && Math.abs(row.optDouble("time") / 1000 - track.optDouble("duration")) <= 3) return resolved(row.optString("url"), source, true); }
            throw new IOException("平台未提供完整公开音源，可能需要登录或仅可试听");
        }
        JSONObject detail = musicu("music.pf_song_detail_svr", "get_song_detail_yqq", new JSONObject().put("song_mid", id), cancelled);
        JSONObject info = detail.optJSONObject("track_info"), track = info == null ? null : song(info, source, null);
        if (track == null || !track.getString("id").equals(id) || track.getBoolean("restricted") || track.optDouble("duration") <= 0) throw new IOException("平台未提供公开下载权限");
        JSONObject result = musicu("vkey.GetVkeyServer", "CgiGetVkey", new JSONObject().put("guid", Long.toString(System.currentTimeMillis()).substring(3)).put("songmid", new JSONArray().put(id)).put("songtype", new JSONArray().put(0)).put("uin", "0").put("loginflag", 0).put("platform", "20"), cancelled);
        JSONArray rows = result.optJSONArray("midurlinfo"), bases = result.optJSONArray("sip");
        if (rows != null && bases != null) for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.getJSONObject(i); String path = row.optString("purl"); if (id.equals(row.optString("songmid")) && !path.isEmpty() && !(path + row.optString("filename")).matches("(?i).*(RS02|try|preview).*")) for (int j = 0; j < bases.length(); j++) try { return resolved(new URL(new URL(bases.getString(j)), path).toString(), source, true); } catch (Exception ignored) {} }
        throw new IOException("QQ 音乐未提供匿名完整音源");
    }
    static JSONObject resolved(String input, String source, boolean official) throws Exception {
        URL u = new URL(input);
        if (official) {
            String host = u.getHost().toLowerCase(Locale.ROOT), suffix = source.equals("netease") ? "music.126.net" : "stream.qqmusic.qq.com";
            if (!(host.equals(suffix) || host.endsWith("." + suffix))) throw new IOException("平台返回了不受支持的音频地址");
            if (u.getProtocol().equals("http")) u = new URL("https", u.getHost(), u.getFile());
        }
        safeUrl(u.toString(), false);
        String extension = "mp3"; java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\.(mp3|m4a|flac|aac|ogg)$", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(u.getPath()); if (m.find()) extension = m.group(1).toLowerCase(Locale.ROOT);
        return new JSONObject().put("url", u.toString()).put("extension", extension).put("mirrored", !official);
    }
    JSONObject resolve(JSONObject input, String endpoint, boolean mirror, BooleanSupplier cancelled) throws Exception {
        String officialError;
        try { return official(input, cancelled); } catch (Exception error) { checkCancelled(cancelled); officialError = error.getMessage(); }
        if (!mirror) throw new IOException(officialError);
        endpoint = safeUrl(endpoint, false).toString();
        JSONObject result = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            mirrorTurn(cancelled);
            try { result = request.get(endpoint + (endpoint.contains("?") ? "&" : "?") + "types=url&source=" + (input.getString("source").equals("qq") ? "tencent" : "netease") + "&id=" + encoded(input.getString("id")) + "&br=320", cancelled); break; }
            catch (IOException error) { if (attempt == 2 || error.getMessage() == null || !error.getMessage().matches(".*HTTP (408|425|429|500|502|503|504).*")) throw error; Thread.sleep(1000L * (attempt + 1)); }
        }
        if (result == null) throw new IOException("备用接口暂时繁忙，请稍后重试");
        double duration = result.optDouble("size", 0) * 8 / (Math.max(1, result.optDouble("br", 320)) * 1000), expected = input.optDouble("duration", 0);
        if (duration > 0 && expected > 0 && Math.abs(duration - expected) > Math.max(10, expected * .08)) throw new IOException("备用音源时长与歌曲不符");
        if (result.optString("url").isEmpty()) throw new IOException(officialError + "；备用接口未返回音源，请稍后重试");
        return resolved(result.getString("url"), input.getString("source"), false);
    }
    private static long lastMirror;
    private static synchronized void mirrorTurn(BooleanSupplier cancelled) throws Exception {
        while (System.currentTimeMillis() - lastMirror < 800) { checkCancelled(cancelled); Thread.sleep(100); }
        lastMirror = System.currentTimeMillis();
    }
    static boolean audioHeader(byte[] b) {
        if (b.length < 12) return false;
        String s = new String(b, 0, Math.min(16, b.length), StandardCharsets.ISO_8859_1);
        return s.startsWith("ID3") || s.startsWith("fLaC") || s.startsWith("OggS") || (s.startsWith("RIFF") && s.substring(8).startsWith("WAVE")) || s.substring(4).startsWith("ftyp") || ((b[0] & 255) == 255 && (b[1] & 224) == 224);
    }
}
