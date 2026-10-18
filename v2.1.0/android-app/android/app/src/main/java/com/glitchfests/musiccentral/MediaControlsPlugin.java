package com.glitchfests.musiccentral;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Bridge between the web app and Android:
 *  - media notification + lock screen controls, with a foreground service so music keeps playing in the background
 *  - sign-in through the system browser with a one-time 127.0.0.1 redirect (Spotify)
 *  - downloading and installing app updates
 */
@CapacitorPlugin(name = "MediaControls")
public class MediaControlsPlugin extends Plugin {
    static MediaControlsPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    void emitAction(String action, long positionMs) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("position", positionMs / 1000.0);
        notifyListeners("action", data);
    }

    // ----- Media notification -----

    @PluginMethod
    public void update(PluginCall call) {
        askForNotificationsOnce();
        Context ctx = getContext();
        boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        PlaybackService.State s = new PlaybackService.State();
        s.title = call.getString("title", "");
        s.artist = call.getString("artist", "");
        s.album = call.getString("album", "");
        s.artUrl = call.getString("art", "");
        s.playing = playing;
        s.positionMs = (long) (call.getDouble("position", 0.0) * 1000);
        s.durationMs = (long) (call.getDouble("duration", 0.0) * 1000);
        PlaybackService.pending = s;
        if (PlaybackService.instance != null) {
            PlaybackService.instance.applyPending();
        } else if (playing) {
            try {
                ContextCompat.startForegroundService(ctx, new Intent(ctx, PlaybackService.class).setAction(PlaybackService.ACTION_UPDATE));
            } catch (Exception e) {
                call.reject("Couldn't start background playback: " + e.getMessage());
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        if (PlaybackService.instance != null) PlaybackService.instance.shutdown();
        call.resolve();
    }

    private void askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33 || getActivity() == null) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = getContext().getSharedPreferences("music-central", Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedNotifications", false)) return;
        prefs.edit().putBoolean("askedNotifications", true).apply();
        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711);
    }

    // ----- Sign-in through the browser -----

    /** Opens `url` (with {REDIRECT} replaced) in the browser and waits for the redirect back to 127.0.0.1:`port` (0 = any free port). */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void loopbackAuth(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("Missing url");
            return;
        }
        int port = call.getInt("port", 0);
        new Thread(() -> {
            try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
                server.setSoTimeout(5 * 60 * 1000);
                String redirect = "http://127.0.0.1:" + server.getLocalPort() + "/callback";
                String full = url.replace("{REDIRECT}", URLEncoder.encode(redirect, "UTF-8"));
                Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(full)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(browser);
                while (true) {
                    try (Socket socket = server.accept()) {
                        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                        String line = in.readLine();
                        String path = line == null ? "" : line.split(" ").length > 1 ? line.split(" ")[1] : "";
                        OutputStream out = socket.getOutputStream();
                        if (!path.startsWith("/callback")) {
                            out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                            continue;
                        }
                        String html = "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:sans-serif;background:#0b0f0c;color:#eef3ef;text-align:center;padding:40px'>"
                            + "<h2>" + (path.contains("error=") ? "Sign-in cancelled" : "Signed in") + "</h2><p>You can go back to Music Central now.</p>"
                            + "<p><a href='musiccentral://open' style='color:#1db954;font-size:18px'>Open Music Central</a></p></body>";
                        byte[] body = html.getBytes(StandardCharsets.UTF_8);
                        out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                        out.write(body);
                        out.flush();
                        int q = path.indexOf('?');
                        JSObject ret = new JSObject();
                        ret.put("query", q >= 0 ? path.substring(q + 1) : "");
                        ret.put("redirectUri", redirect);
                        call.resolve(ret);
                        return;
                    }
                }
            } catch (Exception e) {
                call.reject("Sign-in didn't finish: " + e.getMessage());
            }
        }).start();
    }

    // ----- Updates -----

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void installUpdate(PluginCall call) {
        String url = call.getString("url");
        Context ctx = getContext();
        if (url == null) {
            call.reject("Missing url");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(allow);
            call.reject("Allow Music Central to install apps, then press Update again.");
            return;
        }
        new Thread(() -> {
            try {
                File file = new File(ctx.getCacheDir(), "music-central-update.apk");
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.connect();
                if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
                long total = conn.getContentLengthLong();
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buf = new byte[64 * 1024];
                    long got = 0;
                    int lastPct = -1;
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        got += n;
                        int pct = total > 0 ? (int) (got * 100 / total) : -1;
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("updateProgress", p);
                        }
                    }
                }
                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
                Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(install);
                call.resolve();
            } catch (Exception e) {
                call.reject("Update download failed: " + e.getMessage());
            }
        }).start();
    }
}
