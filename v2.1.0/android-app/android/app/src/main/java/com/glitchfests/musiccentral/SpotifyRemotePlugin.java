package com.glitchfests.musiccentral;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.spotify.android.appremote.api.ConnectionParams;
import com.spotify.android.appremote.api.Connector;
import com.spotify.android.appremote.api.SpotifyAppRemote;
import com.spotify.protocol.client.CallResult;
import com.spotify.protocol.types.Empty;
import com.spotify.protocol.types.PlayerState;

/**
 * Plays Spotify songs through the Spotify app running in the background (Spotify App Remote SDK),
 * so you stay in Music Central. Needs the Spotify app installed and a Premium account.
 */
@CapacitorPlugin(name = "SpotifyRemote")
public class SpotifyRemotePlugin extends Plugin {
    private SpotifyAppRemote remote;

    @PluginMethod
    public void isInstalled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("installed", SpotifyAppRemote.isSpotifyInstalled(getContext()));
        call.resolve(ret);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void connect(PluginCall call) {
        if (remote != null && remote.isConnected()) {
            call.resolve();
            return;
        }
        String clientId = call.getString("clientId");
        String redirectUri = call.getString("redirectUri");
        if (clientId == null || redirectUri == null) {
            call.reject("Missing Spotify Client ID");
            return;
        }
        ConnectionParams params = new ConnectionParams.Builder(clientId)
            .setRedirectUri(redirectUri)
            .showAuthView(true)
            .build();
        // The SDK expects to be called from the main thread.
        getActivity().runOnUiThread(() -> SpotifyAppRemote.connect(getContext(), params, new Connector.ConnectionListener() {
            private boolean settled;

            @Override
            public void onConnected(SpotifyAppRemote r) {
                remote = r;
                remote.getPlayerApi().subscribeToPlayerState().setEventCallback(SpotifyRemotePlugin.this::sendState);
                if (!settled) { settled = true; call.resolve(); }
            }

            @Override
            public void onFailure(Throwable error) {
                remote = null;
                if (!settled) {
                    settled = true;
                    call.reject(describe(error));
                } else {
                    notifyListeners("disconnected", new JSObject());
                }
            }
        }));
    }

    private void sendState(PlayerState ps) {
        JSObject d = new JSObject();
        d.put("uri", ps.track != null ? ps.track.uri : "");
        d.put("paused", ps.isPaused);
        d.put("position", ps.playbackPosition);
        d.put("duration", ps.track != null ? ps.track.duration : 0);
        notifyListeners("state", d);
    }

    private static String describe(Throwable error) {
        String name = error.getClass().getSimpleName();
        if (name.contains("NotLoggedIn")) return "Log in to the Spotify app first.";
        if (name.contains("CouldNotFindSpotifyApp")) return "Install the Spotify app to play Spotify songs here.";
        if (name.contains("UserNotAuthorized")) return "Spotify didn't allow Music Central to control it: " + error.getMessage();
        if (name.contains("Offline")) return "Spotify needs internet to connect.";
        return "Couldn't connect to Spotify: " + (error.getMessage() != null ? error.getMessage() : name);
    }

    private boolean ready(PluginCall call) {
        if (remote != null && remote.isConnected()) return true;
        call.reject("Not connected to Spotify");
        return false;
    }

    private void finish(PluginCall call, CallResult<Empty> result) {
        result.setResultCallback(e -> call.resolve()).setErrorCallback(t -> call.reject(t.getMessage() != null ? t.getMessage() : "Spotify error"));
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void play(PluginCall call) {
        if (ready(call)) finish(call, remote.getPlayerApi().play(call.getString("uri")));
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void pause(PluginCall call) {
        if (ready(call)) finish(call, remote.getPlayerApi().pause());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void resume(PluginCall call) {
        if (ready(call)) finish(call, remote.getPlayerApi().resume());
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    public void seek(PluginCall call) {
        if (ready(call)) finish(call, remote.getPlayerApi().seekTo((long) (call.getDouble("position", 0.0) * 1000)));
    }

    @Override
    protected void handleOnDestroy() {
        SpotifyAppRemote.disconnect(remote);
        remote = null;
    }
}
