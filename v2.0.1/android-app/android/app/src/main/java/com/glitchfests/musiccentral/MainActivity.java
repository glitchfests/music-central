package com.glitchfests.musiccentral;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaControlsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
