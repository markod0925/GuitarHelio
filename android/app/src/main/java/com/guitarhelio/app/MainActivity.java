package com.guitarhelio.app;

import com.getcapacitor.BridgeActivity;
import com.guitarhelio.app.converter.NeuralNoteConverterPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(NeuralNoteConverterPlugin.class);
    }
}
