package com.glitchfests.musiccentral;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps the app alive while music plays in the background and shows the media notification
 * (also used for lock screen, headphone buttons and Bluetooth controls). The web app does the
 * actual playing; this service only mirrors its state and sends button presses back to it.
 */
public class PlaybackService extends Service {
    static final String ACTION_UPDATE = "com.glitchfests.musiccentral.UPDATE";
    static final String ACTION_PLAY = "com.glitchfests.musiccentral.PLAY";
    static final String ACTION_PAUSE = "com.glitchfests.musiccentral.PAUSE";
    static final String ACTION_NEXT = "com.glitchfests.musiccentral.NEXT";
    static final String ACTION_PREV = "com.glitchfests.musiccentral.PREV";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;

    static class State {
        String title = "", artist = "", album = "", artUrl = "";
        boolean playing;
        long positionMs, durationMs;
    }

    static PlaybackService instance;
    static volatile State pending;

    private MediaSessionCompat session;
    private State state = new State();
    private String loadedArtUrl = "";
    private Bitmap art;
    private boolean inForeground;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSessionCompat(this, "MusicCentral");
        session.setSessionActivity(openAppIntent());
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { send("play", 0); }
            @Override public void onPause() { send("pause", 0); }
            @Override public void onSkipToNext() { send("next", 0); }
            @Override public void onSkipToPrevious() { send("prev", 0); }
            @Override public void onSeekTo(long pos) { send("seek", pos); }
            @Override public void onStop() { send("pause", 0); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_PLAY.equals(action)) send("play", 0);
        else if (ACTION_PAUSE.equals(action)) send("pause", 0);
        else if (ACTION_NEXT.equals(action)) send("next", 0);
        else if (ACTION_PREV.equals(action)) send("prev", 0);
        applyPending();
        // A service started with startForegroundService must go to the foreground quickly, even if paused meanwhile.
        if (!inForeground && ACTION_UPDATE.equals(action)) goForeground();
        return START_NOT_STICKY;
    }

    private void send(String action, long positionMs) {
        if (MediaControlsPlugin.instance != null) MediaControlsPlugin.instance.emitAction(action, positionMs);
    }

    void applyPending() {
        State s = pending;
        if (s != null) {
            pending = null;
            state = s;
        }
        if (!state.artUrl.equals(loadedArtUrl)) loadArt(state.artUrl);
        refresh();
    }

    private void refresh() {
        session.setMetadata(new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, state.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs)
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
            .build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_STOP)
            .setState(state.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, state.positionMs, state.playing ? 1f : 0f)
            .build());
        if (state.playing) {
            goForeground();
        } else {
            if (inForeground) {
                // Paused: let the notification be swiped away and the system reclaim the service if needed.
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH);
                inForeground = false;
            }
            try {
                NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification());
            } catch (SecurityException ignored) {
                // Notifications not allowed; playback still works.
            }
        }
    }

    private void goForeground() {
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        inForeground = true;
    }

    private Notification buildNotification() {
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(state.title.isEmpty() ? "Music Central" : state.title)
            .setContentText(state.artist)
            .setLargeIcon(art)
            .setContentIntent(openAppIntent())
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(state.playing)
            .addAction(android.R.drawable.ic_media_previous, "Previous", serviceIntent(ACTION_PREV))
            .addAction(state.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                state.playing ? "Pause" : "Play", serviceIntent(state.playing ? ACTION_PAUSE : ACTION_PLAY))
            .addAction(android.R.drawable.ic_media_next, "Next", serviceIntent(ACTION_NEXT))
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private PendingIntent serviceIntent(String action) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent openAppIntent() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void loadArt(String url) {
        loadedArtUrl = url;
        art = null;
        if (url == null || !url.startsWith("http")) return;
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                try (InputStream in = conn.getInputStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(in);
                    if (bmp != null && url.equals(loadedArtUrl)) {
                        art = Bitmap.createScaledBitmap(bmp, 512, 512 * bmp.getHeight() / Math.max(1, bmp.getWidth()), true);
                        new android.os.Handler(getMainLooper()).post(this::refresh);
                    }
                }
            } catch (Exception ignored) {
                // No cover art; the notification still works.
            }
        }).start();
    }

    void shutdown() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        inForeground = false;
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away from recents: stop playback controls too.
        shutdown();
    }

    @Override
    public void onDestroy() {
        instance = null;
        session.release();
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
