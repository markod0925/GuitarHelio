use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[cfg(target_os = "android")]
use std::{
    ffi::{c_char, CStr, CString},
    mem,
    os::unix::ffi::OsStrExt,
    ptr::{self, NonNull},
};

#[cfg(target_os = "android")]
use ort::{
    memory::Allocator,
    sys::{
        ExecutionMode, GraphOptimizationLevel, ONNXTensorElementDataType, ONNXType,
        OrtAllocatorType, OrtEnv, OrtLoggingLevel, OrtMemType, OrtMemoryInfo, OrtSession,
        OrtSessionOptions, OrtStatusPtr, OrtTensorTypeAndShapeInfo, OrtTypeInfo, OrtValue,
    },
    AsPointer,
};
#[cfg(not(target_os = "android"))]
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::ValueType,
};

#[cfg(not(target_os = "android"))]
use crate::inference::run_raw_session;
#[cfg(target_os = "android")]
use crate::inference::{feature_array, validate_feature_batch};
use crate::{
    config::DEFAULT_OUTPUT_NAMES,
    error::RuntimeError,
    postprocess::decode_conservatively,
    types::{
        DecodedOutput, FeatureBatch, ModelMetadata, ModelOutput, NamedTensorOutput, TensorMetadata,
    },
};

pub struct FretNetRuntime {
    model_path: PathBuf,
    #[cfg(not(target_os = "android"))]
    session: Session,
    #[cfg(target_os = "android")]
    session: AndroidOrtSession,
    metadata: ModelMetadata,
    load_time: Duration,
}

#[cfg(target_os = "android")]
#[derive(Debug)]
struct OrtOwned<T> {
    ptr: NonNull<T>,
    release: unsafe extern "system" fn(*mut T),
}

#[cfg(target_os = "android")]
impl<T> OrtOwned<T> {
    fn from_raw(
        ptr: *mut T,
        release: unsafe extern "system" fn(*mut T),
        context: &str,
    ) -> Result<Self, RuntimeError> {
        let ptr = NonNull::new(ptr).ok_or_else(|| {
            RuntimeError::SessionCreation(format!(
                "{context}: ONNX Runtime returned a null pointer"
            ))
        })?;
        Ok(Self { ptr, release })
    }

    fn as_ptr(&self) -> *mut T {
        self.ptr.as_ptr()
    }
}

#[cfg(target_os = "android")]
impl<T> Drop for OrtOwned<T> {
    fn drop(&mut self) {
        unsafe {
            (self.release)(self.ptr.as_ptr());
        }
    }
}

#[cfg(target_os = "android")]
struct AndroidOrtSession {
    _env: OrtOwned<OrtEnv>,
    session: OrtOwned<OrtSession>,
    memory_info: OrtOwned<OrtMemoryInfo>,
    input_name: CString,
    output_names: Vec<CString>,
}

impl FretNetRuntime {
    #[cfg(target_os = "android")]
    fn ensure_android_ort_initialized(
        ort_library_path: Option<&Path>,
        mut on_stage: impl FnMut(&str),
    ) -> Result<(), RuntimeError> {
        fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
            if candidate.as_os_str().is_empty() {
                return;
            }
            if candidates.iter().any(|existing| existing == &candidate) {
                return;
            }
            candidates.push(candidate);
        }

        let mut candidates = Vec::<PathBuf>::new();
        if let Some(configured_path) = ort_library_path {
            let trimmed = configured_path.to_string_lossy().trim().to_owned();
            if !trimmed.is_empty() {
                push_candidate(&mut candidates, PathBuf::from(trimmed));
            }
            if let Some(file_name) = configured_path.file_name() {
                push_candidate(&mut candidates, PathBuf::from(file_name));
            }
        }
        push_candidate(&mut candidates, PathBuf::from("libonnxruntime_fretnet.so"));
        push_candidate(&mut candidates, PathBuf::from("libonnxruntime.so"));

        let mut errors = Vec::<String>::new();
        for candidate in candidates {
            on_stage("load:android:ort_init_from:begin");
            let candidate_stage = format!(
                "load:android:ort_init_from:candidate={}",
                candidate.display()
            );
            on_stage(&candidate_stage);
            match ort::init_from(&candidate) {
                Ok(builder) => {
                    on_stage("load:android:ort_init_from:commit");
                    if builder.commit() {
                        on_stage("load:android:ort_init_from:commit_applied");
                    } else {
                        on_stage("load:android:ort_init_from:commit_already_configured");
                    }
                    return Ok(());
                }
                Err(error) => {
                    errors.push(format!("{}: {error}", candidate.display()));
                }
            }
        }

        on_stage("load:android:ort_init:begin");
        if ort::init().commit() {
            on_stage("load:android:ort_init:commit_applied");
            return Ok(());
        }
        on_stage("load:android:ort_init:commit_already_configured");
        if errors.is_empty() {
            return Ok(());
        }
        Err(RuntimeError::SessionCreation(format!(
            "Failed to initialize Android ORT dynamic library. Attempts: {}",
            errors.join(" | ")
        )))
    }

    #[cfg(target_os = "android")]
    fn load_android_session(
        model_path: &Path,
        ort_library_path: Option<&Path>,
        mut on_stage: impl FnMut(&str),
    ) -> Result<(AndroidOrtSession, ModelMetadata), RuntimeError> {
        Self::ensure_android_ort_initialized(ort_library_path, |stage| on_stage(stage))?;

        let api = ort::api();
        let log_id = CString::new("guitarhelio_fretnet")
            .expect("static log identifier must not contain NUL");

        on_stage("load:android:env:create:before");
        let mut env_ptr = ptr::null_mut();
        ort_status_to_result(
            unsafe {
                (api.CreateEnv)(
                    OrtLoggingLevel::ORT_LOGGING_LEVEL_WARNING,
                    log_id.as_ptr(),
                    &mut env_ptr,
                )
            },
            "OrtApi::CreateEnv",
        )?;
        let env = OrtOwned::from_raw(env_ptr, api.ReleaseEnv, "OrtApi::CreateEnv")?;
        on_stage("load:android:env:create:after");

        on_stage("load:android:session_options:create:before");
        let mut options_ptr = ptr::null_mut();
        ort_status_to_result(
            unsafe { (api.CreateSessionOptions)(&mut options_ptr) },
            "OrtApi::CreateSessionOptions",
        )?;
        let options = OrtOwned::from_raw(
            options_ptr,
            api.ReleaseSessionOptions,
            "OrtApi::CreateSessionOptions",
        )?;
        on_stage("load:android:session_options:create:after");

        ort_option_call(
            &mut on_stage,
            "load:android:session_options:disable_cpu_mem_arena:before",
            "load:android:session_options:disable_cpu_mem_arena:after",
            "OrtApi::DisableCpuMemArena",
            || unsafe { (api.DisableCpuMemArena)(options.as_ptr()) },
        )?;
        ort_option_call(
            &mut on_stage,
            "load:android:session_options:optimization_level:before",
            "load:android:session_options:optimization_level:after",
            "OrtApi::SetSessionGraphOptimizationLevel",
            || unsafe {
                (api.SetSessionGraphOptimizationLevel)(
                    options.as_ptr(),
                    GraphOptimizationLevel::ORT_ENABLE_BASIC,
                )
            },
        )?;
        ort_option_call(
            &mut on_stage,
            "load:android:session_options:intra_threads:before",
            "load:android:session_options:intra_threads:after",
            "OrtApi::SetIntraOpNumThreads",
            || unsafe { (api.SetIntraOpNumThreads)(options.as_ptr(), 1) },
        )?;
        ort_option_call(
            &mut on_stage,
            "load:android:session_options:inter_threads:before",
            "load:android:session_options:inter_threads:after",
            "OrtApi::SetInterOpNumThreads",
            || unsafe { (api.SetInterOpNumThreads)(options.as_ptr(), 1) },
        )?;
        ort_option_call(
            &mut on_stage,
            "load:android:session_options:execution_mode:before",
            "load:android:session_options:execution_mode:after",
            "OrtApi::SetSessionExecutionMode",
            || unsafe {
                (api.SetSessionExecutionMode)(options.as_ptr(), ExecutionMode::ORT_SEQUENTIAL)
            },
        )?;
        ort_add_session_config_entry(
            options.as_ptr(),
            "session.intra_op.allow_spinning",
            "0",
            &mut on_stage,
            "load:android:session_options:intra_spinning:before",
            "load:android:session_options:intra_spinning:after",
        )?;
        ort_add_session_config_entry(
            options.as_ptr(),
            "session.inter_op.allow_spinning",
            "0",
            &mut on_stage,
            "load:android:session_options:inter_spinning:before",
            "load:android:session_options:inter_spinning:after",
        )?;

        on_stage("load:android:model_path:prepare:before");
        let model_path_cstr = path_to_cstring(model_path)?;
        on_stage("load:android:model_path:prepare:after");

        on_stage("load:android:model_path_handoff:before");
        on_stage("load:android:session:create:before");
        let mut session_ptr = ptr::null_mut();
        ort_status_to_result(
            unsafe {
                (api.CreateSession)(
                    env.as_ptr(),
                    model_path_cstr.as_ptr(),
                    options.as_ptr(),
                    &mut session_ptr,
                )
            },
            "OrtApi::CreateSession",
        )?;
        let session = OrtOwned::from_raw(session_ptr, api.ReleaseSession, "OrtApi::CreateSession")?;
        on_stage("load:android:session:create:after");
        on_stage("load:android:model_path_handoff:after");

        on_stage("load:android:allocator:default:before");
        let allocator = Allocator::default();
        on_stage("load:android:allocator:default:after");

        on_stage("load:android:input_metadata:count:before");
        let mut input_count = 0usize;
        ort_status_to_result(
            unsafe {
                (api.SessionGetInputCount)(session.as_ptr() as *const OrtSession, &mut input_count)
            },
            "OrtApi::SessionGetInputCount",
        )?;
        on_stage("load:android:input_metadata:count:after");

        on_stage("load:android:output_metadata:count:before");
        let mut output_count = 0usize;
        ort_status_to_result(
            unsafe {
                (api.SessionGetOutputCount)(
                    session.as_ptr() as *const OrtSession,
                    &mut output_count,
                )
            },
            "OrtApi::SessionGetOutputCount",
        )?;
        on_stage("load:android:output_metadata:count:after");

        let mut inputs = Vec::with_capacity(input_count);
        for index in 0..input_count {
            inputs.push(query_tensor_metadata(
                session.as_ptr() as *const OrtSession,
                &allocator,
                index,
                "input",
                api.SessionGetInputName,
                api.SessionGetInputTypeInfo,
                &mut on_stage,
            )?);
        }

        let mut outputs = Vec::with_capacity(output_count);
        for index in 0..output_count {
            outputs.push(query_tensor_metadata(
                session.as_ptr() as *const OrtSession,
                &allocator,
                index,
                "output",
                api.SessionGetOutputName,
                api.SessionGetOutputTypeInfo,
                &mut on_stage,
            )?);
        }

        if inputs.len() != 1 {
            return Err(RuntimeError::UnexpectedInputCount(inputs.len()));
        }
        if outputs.is_empty() {
            return Err(RuntimeError::UnexpectedOutputCount(0));
        }

        on_stage("load:android:memory_info:create:before");
        let mut memory_info_ptr = ptr::null_mut();
        ort_status_to_result(
            unsafe {
                (api.CreateCpuMemoryInfo)(
                    OrtAllocatorType::OrtArenaAllocator,
                    OrtMemType::OrtMemTypeDefault,
                    &mut memory_info_ptr,
                )
            },
            "OrtApi::CreateCpuMemoryInfo",
        )?;
        let memory_info = OrtOwned::from_raw(
            memory_info_ptr,
            api.ReleaseMemoryInfo,
            "OrtApi::CreateCpuMemoryInfo",
        )?;
        on_stage("load:android:memory_info:create:after");

        on_stage("load:android:wrapper:create:before");
        let input_name = CString::new(inputs[0].name.clone()).map_err(|_| {
            RuntimeError::SessionCreation("Input name contains an embedded NUL byte".to_owned())
        })?;
        let output_names = outputs
            .iter()
            .map(|tensor| {
                CString::new(tensor.name.clone()).map_err(|_| {
                    RuntimeError::SessionCreation(format!(
                        "Output name '{}' contains an embedded NUL byte",
                        tensor.name
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let runtime = AndroidOrtSession {
            _env: env,
            session,
            memory_info,
            input_name,
            output_names,
        };
        on_stage("load:android:wrapper:create:after");

        Ok((
            runtime,
            ModelMetadata {
                model_path: model_path.display().to_string(),
                inputs,
                outputs,
            },
        ))
    }

    pub fn load(model_path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        Self::load_with_stage_callback(model_path, None, |_| {})
    }

    pub fn load_with_stage_callback(
        model_path: impl AsRef<Path>,
        #[cfg(target_os = "android")] ort_library_path: Option<&Path>,
        #[cfg(not(target_os = "android"))] _ort_library_path: Option<&Path>,
        mut on_stage: impl FnMut(&str),
    ) -> Result<Self, RuntimeError> {
        on_stage("load:validate_model_path");
        let model_path = model_path.as_ref().to_path_buf();
        if !model_path.exists() {
            return Err(RuntimeError::MissingModelFile(model_path));
        }

        let started = Instant::now();

        #[cfg(target_os = "android")]
        {
            let (session, metadata) =
                Self::load_android_session(&model_path, ort_library_path, |stage| on_stage(stage))?;
            on_stage("load:ready");
            return Ok(Self {
                model_path,
                session,
                metadata,
                load_time: started.elapsed(),
            });
        }

        #[cfg(not(target_os = "android"))]
        {
            on_stage("load:session_builder:new");
            let mut builder =
                Session::builder().map_err(|err| RuntimeError::SessionCreation(err.to_string()))?;

            on_stage("load:desktop:with_optimization_level");
            builder = builder
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|err| RuntimeError::SessionCreation(err.to_string()))?;

            on_stage("load:commit_from_file:begin");
            let session = builder.commit_from_file(&model_path).map_err(|err| {
                RuntimeError::SessionCreation(format!(
                    "{} (elapsed_ms={:.2})",
                    err,
                    started.elapsed().as_secs_f64() * 1000.0
                ))
            })?;
            on_stage("load:commit_from_file:done");

            on_stage("load:metadata:collect");
            let metadata = ModelMetadata {
                model_path: model_path.display().to_string(),
                inputs: collect_input_metadata(session.inputs()),
                outputs: collect_output_metadata(session.outputs()),
            };

            if metadata.inputs.len() != 1 {
                return Err(RuntimeError::UnexpectedInputCount(metadata.inputs.len()));
            }

            if metadata.outputs.is_empty() {
                return Err(RuntimeError::UnexpectedOutputCount(0));
            }

            on_stage("load:ready");
            Ok(Self {
                model_path,
                session,
                metadata,
                load_time: started.elapsed(),
            })
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn metadata(&self) -> &ModelMetadata {
        &self.metadata
    }

    pub fn load_time(&self) -> Duration {
        self.load_time
    }

    pub fn infer_features(&mut self, features: &FeatureBatch) -> Result<ModelOutput, RuntimeError> {
        #[cfg(target_os = "android")]
        {
            return self.session.run(features, &self.metadata);
        }

        #[cfg(not(target_os = "android"))]
        {
            let outputs = run_raw_session(&mut self.session, &self.metadata, features)?;
            let mut tensors = Vec::with_capacity(self.metadata.outputs.len());

            for (index, meta) in self.metadata.outputs.iter().enumerate() {
                let value = &outputs[index];
                let extracted = value.try_extract_array::<f32>().map_err(|err| {
                    RuntimeError::OutputExtraction {
                        name: meta.name.clone(),
                        message: err.to_string(),
                    }
                })?;

                tensors.push(NamedTensorOutput {
                    name: meta.name.clone(),
                    data: extracted.to_owned(),
                });
            }

            Ok(ModelOutput { tensors })
        }
    }

    pub fn decode_output(&self, output: &ModelOutput) -> Result<DecodedOutput, RuntimeError> {
        decode_conservatively(output)
    }

    pub fn default_output_names(&self) -> Vec<String> {
        self.metadata
            .outputs
            .iter()
            .map(|item| item.name.clone())
            .collect()
    }

    pub fn output_name_fallbacks(&self) -> Vec<String> {
        DEFAULT_OUTPUT_NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .collect()
    }
}

#[cfg(target_os = "android")]
impl AndroidOrtSession {
    fn run(
        &mut self,
        features: &FeatureBatch,
        metadata: &ModelMetadata,
    ) -> Result<ModelOutput, RuntimeError> {
        validate_feature_batch(features, metadata)?;

        let api = ort::api();
        let feature_view = feature_array(features);
        let feature_slice = feature_view.as_slice_memory_order().ok_or_else(|| {
            RuntimeError::Inference(
                "FRETNET feature batch must be contiguous before CreateTensorWithDataAsOrtValue"
                    .to_owned(),
            )
        })?;
        let input_shape = feature_batch_ort_shape(features);

        let mut input_value_ptr = ptr::null_mut();
        ort_status_to_result(
            unsafe {
                (api.CreateTensorWithDataAsOrtValue)(
                    self.memory_info.as_ptr() as *const OrtMemoryInfo,
                    feature_slice.as_ptr().cast_mut().cast(),
                    feature_slice.len() * mem::size_of::<f32>(),
                    input_shape.as_ptr(),
                    input_shape.len(),
                    ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
                    &mut input_value_ptr,
                )
            },
            "OrtApi::CreateTensorWithDataAsOrtValue",
        )?;
        let input_value = OrtOwned::from_raw(
            input_value_ptr,
            api.ReleaseValue,
            "OrtApi::CreateTensorWithDataAsOrtValue",
        )?;

        let input_names = [self.input_name.as_ptr()];
        let input_values = [input_value.as_ptr() as *const OrtValue];
        let output_name_ptrs = self
            .output_names
            .iter()
            .map(|name| name.as_ptr())
            .collect::<Vec<_>>();
        let mut output_value_ptrs = vec![ptr::null_mut::<OrtValue>(); self.output_names.len()];

        ort_status_to_result(
            unsafe {
                (api.Run)(
                    self.session.as_ptr(),
                    ptr::null(),
                    input_names.as_ptr(),
                    input_values.as_ptr(),
                    input_values.len(),
                    output_name_ptrs.as_ptr(),
                    output_name_ptrs.len(),
                    output_value_ptrs.as_mut_ptr(),
                )
            },
            "OrtApi::Run",
        )?;

        let mut tensors = Vec::with_capacity(output_value_ptrs.len());
        for (index, output_ptr) in output_value_ptrs.into_iter().enumerate() {
            let meta =
                metadata
                    .outputs
                    .get(index)
                    .ok_or_else(|| RuntimeError::OutputExtraction {
                        name: format!("output[{index}]"),
                        message: "Output metadata vector is shorter than ONNX output vector"
                            .to_owned(),
                    })?;
            let value =
                OrtOwned::from_raw(output_ptr, api.ReleaseValue, "OrtApi::Run output value")?;
            tensors.push(extract_output_tensor(api, &value, meta)?);
        }

        Ok(ModelOutput { tensors })
    }
}

#[cfg(not(target_os = "android"))]
fn collect_input_metadata(items: &[ort::value::Outlet]) -> Vec<TensorMetadata> {
    items.iter().map(tensor_metadata_from_input).collect()
}

#[cfg(not(target_os = "android"))]
fn tensor_metadata_from_input(item: &ort::value::Outlet) -> TensorMetadata {
    let (element_type, dimensions) = tensor_shape_from_value_type(item.dtype());
    TensorMetadata {
        name: item.name().to_owned(),
        element_type,
        dimensions,
    }
}

#[cfg(not(target_os = "android"))]
fn collect_output_metadata(items: &[ort::value::Outlet]) -> Vec<TensorMetadata> {
    items.iter().map(tensor_metadata_from_output).collect()
}

#[cfg(not(target_os = "android"))]
fn tensor_metadata_from_output(item: &ort::value::Outlet) -> TensorMetadata {
    let (element_type, dimensions) = tensor_shape_from_value_type(item.dtype());
    TensorMetadata {
        name: item.name().to_owned(),
        element_type,
        dimensions,
    }
}

#[cfg(not(target_os = "android"))]
fn tensor_shape_from_value_type(value_type: &ValueType) -> (String, Vec<Option<i64>>) {
    if let Some(shape) = value_type.tensor_shape() {
        let dims = shape
            .iter()
            .copied()
            .map(|dim| if dim < 0 { None } else { Some(dim) })
            .collect();
        let element_type = value_type
            .tensor_type()
            .map(|ty| format!("{ty:?}"))
            .unwrap_or_else(|| format!("{value_type:?}"));
        (element_type, dims)
    } else {
        (format!("{value_type:?}"), Vec::new())
    }
}

#[cfg(any(test, target_os = "android"))]
fn feature_batch_ort_shape(features: &FeatureBatch) -> [i64; 5] {
    let shape = features.shape();
    [
        shape[0] as i64,
        shape[1] as i64,
        shape[2] as i64,
        shape[3] as i64,
        shape[4] as i64,
    ]
}

#[cfg(any(test, target_os = "android"))]
fn dims_i64_to_shape_usize(dims: &[i64], name: &str) -> Result<Vec<usize>, RuntimeError> {
    dims.iter()
        .copied()
        .map(|dim| {
            usize::try_from(dim).map_err(|_| RuntimeError::OutputExtraction {
                name: name.to_owned(),
                message: format!("Tensor dimension {dim} is negative or does not fit in usize"),
            })
        })
        .collect()
}

#[cfg(target_os = "android")]
fn ort_status_to_result(status: OrtStatusPtr, context: &str) -> Result<(), RuntimeError> {
    if status.0.is_null() {
        return Ok(());
    }

    let api = ort::api();
    let message = unsafe { CStr::from_ptr((api.GetErrorMessage)(status.0)) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        (api.ReleaseStatus)(status.0);
    }
    Err(RuntimeError::SessionCreation(format!(
        "{context}: {message}"
    )))
}

#[cfg(target_os = "android")]
fn ort_option_call(
    on_stage: &mut impl FnMut(&str),
    before: &str,
    after: &str,
    context: &str,
    call: impl FnOnce() -> OrtStatusPtr,
) -> Result<(), RuntimeError> {
    on_stage(before);
    ort_status_to_result(call(), context)?;
    on_stage(after);
    Ok(())
}

#[cfg(target_os = "android")]
fn ort_add_session_config_entry(
    options: *mut OrtSessionOptions,
    key: &str,
    value: &str,
    on_stage: &mut impl FnMut(&str),
    before: &str,
    after: &str,
) -> Result<(), RuntimeError> {
    let api = ort::api();
    let key = CString::new(key).expect("static config key must not contain NUL");
    let value = CString::new(value).expect("static config value must not contain NUL");
    ort_option_call(
        on_stage,
        before,
        after,
        "OrtApi::AddSessionConfigEntry",
        || unsafe { (api.AddSessionConfigEntry)(options, key.as_ptr(), value.as_ptr()) },
    )
}

#[cfg(target_os = "android")]
fn path_to_cstring(path: &Path) -> Result<CString, RuntimeError> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        RuntimeError::SessionCreation(format!(
            "Model path contains an embedded NUL byte: {}",
            path.display()
        ))
    })
}

#[cfg(target_os = "android")]
fn query_tensor_metadata(
    session: *const OrtSession,
    allocator: &Allocator,
    index: usize,
    kind: &str,
    get_name: unsafe extern "system" fn(
        *const OrtSession,
        usize,
        *mut ort::sys::OrtAllocator,
        *mut *mut c_char,
    ) -> OrtStatusPtr,
    get_type_info: unsafe extern "system" fn(
        *const OrtSession,
        usize,
        *mut *mut OrtTypeInfo,
    ) -> OrtStatusPtr,
    on_stage: &mut impl FnMut(&str),
) -> Result<TensorMetadata, RuntimeError> {
    let api = ort::api();
    let prefix = format!("load:android:{kind}_metadata:index={index}");

    let name_before = format!("{prefix}:name:before");
    on_stage(&name_before);
    let mut name_ptr = ptr::null_mut();
    ort_status_to_result(
        unsafe { get_name(session, index, allocator.ptr().cast_mut(), &mut name_ptr) },
        &format!(
            "OrtApi::SessionGet{}Name[{index}]",
            if kind == "input" { "Input" } else { "Output" }
        ),
    )?;
    let name_ptr = NonNull::new(name_ptr).ok_or_else(|| {
        RuntimeError::SessionCreation(format!(
            "OrtApi::SessionGet{}Name[{index}] returned a null name pointer",
            if kind == "input" { "Input" } else { "Output" }
        ))
    })?;
    let name = unsafe { CStr::from_ptr(name_ptr.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    unsafe {
        allocator.free(name_ptr.as_ptr());
    }
    let name_after = format!("{prefix}:name:after");
    on_stage(&name_after);

    let type_before = format!("{prefix}:type_info:before");
    on_stage(&type_before);
    let mut type_info_ptr = ptr::null_mut();
    ort_status_to_result(
        unsafe { get_type_info(session, index, &mut type_info_ptr) },
        &format!(
            "OrtApi::SessionGet{}TypeInfo[{index}]",
            if kind == "input" { "Input" } else { "Output" }
        ),
    )?;
    let type_info = OrtOwned::from_raw(
        type_info_ptr,
        api.ReleaseTypeInfo,
        &format!(
            "OrtApi::SessionGet{}TypeInfo[{index}]",
            if kind == "input" { "Input" } else { "Output" }
        ),
    )?;
    let type_after = format!("{prefix}:type_info:after");
    on_stage(&type_after);

    let tensor_before = format!("{prefix}:tensor_info:before");
    on_stage(&tensor_before);
    let tensor = tensor_metadata_from_type_info(
        api,
        type_info.as_ptr() as *const OrtTypeInfo,
        &name,
        kind,
        index,
    )?;
    let tensor_after = format!("{prefix}:tensor_info:after");
    on_stage(&tensor_after);
    Ok(tensor)
}

#[cfg(target_os = "android")]
fn tensor_metadata_from_type_info(
    api: &ort::sys::OrtApi,
    type_info: *const OrtTypeInfo,
    name: &str,
    kind: &str,
    index: usize,
) -> Result<TensorMetadata, RuntimeError> {
    let mut onnx_type = ONNXType::ONNX_TYPE_UNKNOWN;
    ort_status_to_result(
        unsafe { (api.GetOnnxTypeFromTypeInfo)(type_info, &mut onnx_type) },
        &format!("OrtApi::GetOnnxTypeFromTypeInfo {kind}[{index}]"),
    )?;
    if !matches!(
        onnx_type,
        ONNXType::ONNX_TYPE_TENSOR | ONNXType::ONNX_TYPE_SPARSETENSOR
    ) {
        return Err(RuntimeError::UnsupportedElementType(format!(
            "{kind}[{index}] is not a tensor: {onnx_type:?}"
        )));
    }

    let mut tensor_info_ptr = ptr::null();
    ort_status_to_result(
        unsafe { (api.CastTypeInfoToTensorInfo)(type_info, &mut tensor_info_ptr) },
        &format!("OrtApi::CastTypeInfoToTensorInfo {kind}[{index}]"),
    )?;
    let tensor_info =
        NonNull::new(tensor_info_ptr as *mut OrtTensorTypeAndShapeInfo).ok_or_else(|| {
            RuntimeError::SessionCreation(format!(
            "OrtApi::CastTypeInfoToTensorInfo {kind}[{index}] returned a null tensor info pointer"
        ))
        })?;

    let mut element_type = ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    ort_status_to_result(
        unsafe {
            (api.GetTensorElementType)(
                tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                &mut element_type,
            )
        },
        &format!("OrtApi::GetTensorElementType {kind}[{index}]"),
    )?;

    let mut dim_count = 0usize;
    ort_status_to_result(
        unsafe {
            (api.GetDimensionsCount)(
                tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                &mut dim_count,
            )
        },
        &format!("OrtApi::GetDimensionsCount {kind}[{index}]"),
    )?;
    let mut dims = vec![0_i64; dim_count];
    if dim_count > 0 {
        ort_status_to_result(
            unsafe {
                (api.GetDimensions)(
                    tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                    dims.as_mut_ptr(),
                    dim_count,
                )
            },
            &format!("OrtApi::GetDimensions {kind}[{index}]"),
        )?;
    }

    Ok(TensorMetadata {
        name: name.to_owned(),
        element_type: format!("{element_type:?}"),
        dimensions: dims
            .into_iter()
            .map(|dim| if dim < 0 { None } else { Some(dim) })
            .collect(),
    })
}

#[cfg(target_os = "android")]
fn extract_output_tensor(
    api: &ort::sys::OrtApi,
    value: &OrtOwned<OrtValue>,
    meta: &TensorMetadata,
) -> Result<NamedTensorOutput, RuntimeError> {
    let mut is_tensor = 0_i32;
    ort_status_to_result(
        unsafe { (api.IsTensor)(value.as_ptr() as *const OrtValue, &mut is_tensor) },
        &format!("OrtApi::IsTensor '{}'", meta.name),
    )?;
    if is_tensor == 0 {
        return Err(RuntimeError::OutputExtraction {
            name: meta.name.clone(),
            message: "ONNX Runtime returned a non-tensor output".to_owned(),
        });
    }

    let mut tensor_info_ptr = ptr::null_mut();
    ort_status_to_result(
        unsafe {
            (api.GetTensorTypeAndShape)(value.as_ptr() as *const OrtValue, &mut tensor_info_ptr)
        },
        &format!("OrtApi::GetTensorTypeAndShape '{}'", meta.name),
    )?;
    let tensor_info = OrtOwned::from_raw(
        tensor_info_ptr,
        api.ReleaseTensorTypeAndShapeInfo,
        &format!("OrtApi::GetTensorTypeAndShape '{}'", meta.name),
    )?;

    let mut element_type = ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    ort_status_to_result(
        unsafe {
            (api.GetTensorElementType)(
                tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                &mut element_type,
            )
        },
        &format!("OrtApi::GetTensorElementType '{}'", meta.name),
    )?;
    if element_type != ONNXTensorElementDataType::ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT {
        return Err(RuntimeError::UnsupportedElementType(format!(
            "{} returned {:?}, expected float32",
            meta.name, element_type
        )));
    }

    let mut dim_count = 0usize;
    ort_status_to_result(
        unsafe {
            (api.GetDimensionsCount)(
                tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                &mut dim_count,
            )
        },
        &format!("OrtApi::GetDimensionsCount '{}'", meta.name),
    )?;
    let mut dims = vec![0_i64; dim_count];
    if dim_count > 0 {
        ort_status_to_result(
            unsafe {
                (api.GetDimensions)(
                    tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                    dims.as_mut_ptr(),
                    dim_count,
                )
            },
            &format!("OrtApi::GetDimensions '{}'", meta.name),
        )?;
    }
    let shape = dims_i64_to_shape_usize(&dims, &meta.name)?;

    let mut element_count = 0usize;
    ort_status_to_result(
        unsafe {
            (api.GetTensorShapeElementCount)(
                tensor_info.as_ptr() as *const OrtTensorTypeAndShapeInfo,
                &mut element_count,
            )
        },
        &format!("OrtApi::GetTensorShapeElementCount '{}'", meta.name),
    )?;

    let mut data_ptr = ptr::null_mut();
    ort_status_to_result(
        unsafe { (api.GetTensorMutableData)(value.as_ptr(), &mut data_ptr) },
        &format!("OrtApi::GetTensorMutableData '{}'", meta.name),
    )?;
    let values = if element_count == 0 {
        Vec::new()
    } else {
        let data_ptr =
            NonNull::new(data_ptr.cast::<f32>()).ok_or_else(|| RuntimeError::OutputExtraction {
                name: meta.name.clone(),
                message: "ONNX Runtime returned a null tensor data pointer".to_owned(),
            })?;
        unsafe { std::slice::from_raw_parts(data_ptr.as_ptr(), element_count) }.to_vec()
    };
    let tensor =
        ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&shape), values).map_err(|error| {
            RuntimeError::OutputExtraction {
                name: meta.name.clone(),
                message: format!("Failed to materialize ndarray from ORT output: {error}"),
            }
        })?;

    Ok(NamedTensorOutput {
        name: meta.name.clone(),
        data: tensor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_batch_ort_shape_uses_i64_dimensions() {
        let batch = FeatureBatch::synthetic(1, 32, 6, 144, 9);
        let dims = feature_batch_ort_shape(&batch);
        assert_eq!(dims, [1, 32, 6, 144, 9]);
        assert_eq!(std::mem::align_of_val(&dims), std::mem::align_of::<i64>());
    }

    #[test]
    fn dims_i64_to_shape_usize_rejects_negative_values() {
        let error =
            dims_i64_to_shape_usize(&[1, -1, 9], "tablature").expect_err("negative dims must fail");
        assert!(matches!(error, RuntimeError::OutputExtraction { .. }));
    }
}
