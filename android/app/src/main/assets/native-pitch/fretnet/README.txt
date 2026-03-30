The committed FretNet ONNX model for Android lives here as:

model.onnx

The Android native pitch pipeline stages this asset to app-private storage and passes the
resulting filesystem path into the Rust FretNet runtime.

If you intentionally replace or remove the model, the runtime reports an explicit initialization
error instead of silently falling back.
