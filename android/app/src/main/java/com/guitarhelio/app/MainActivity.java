package com.guitarhelio.app;

import android.os.Bundle;
import android.util.Log;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.guitarhelio.app.converter.NeuralNoteConverterPlugin;
import com.guitarhelio.app.display.KeepScreenOnPlugin;
import com.guitarhelio.app.pitch.NativePitchInputPlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "GuitarHelioMain";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NeuralNoteConverterPlugin.class);
        registerPlugin(KeepScreenOnPlugin.class);
        registerPlugin(NativePitchInputPlugin.class);
        super.onCreate(savedInstanceState);
        Log.i(TAG, "[GH][platform=android][scene=MainActivity][subsystem=lifecycle][INFO] onCreate");
        enterImmersiveMode();
    }

    @Override
    public void onResume() {
        super.onResume();
        Log.i(TAG, "[GH][platform=android][scene=MainActivity][subsystem=lifecycle][INFO] onResume");
        enterImmersiveMode();
    }

    @Override
    public void onPause() {
        Log.i(TAG, "[GH][platform=android][scene=MainActivity][subsystem=lifecycle][INFO] onPause");
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            Log.i(TAG, "[GH][platform=android][scene=MainActivity][subsystem=lifecycle][INFO] onWindowFocusChanged hasFocus=true");
            enterImmersiveMode();
        }
    }

    private void enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller == null) return;
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
