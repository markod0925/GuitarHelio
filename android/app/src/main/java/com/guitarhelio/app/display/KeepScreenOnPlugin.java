package com.guitarhelio.app.display;

import android.app.Activity;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepScreenOn")
public class KeepScreenOnPlugin extends Plugin {
    @PluginMethod
    public void enable(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Android activity unavailable.");
            return;
        }
        activity.runOnUiThread(() -> {
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Android activity unavailable.");
            return;
        }
        activity.runOnUiThread(() -> {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}
