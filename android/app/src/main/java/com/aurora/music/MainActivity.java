package com.aurora.music;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AuroraAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
