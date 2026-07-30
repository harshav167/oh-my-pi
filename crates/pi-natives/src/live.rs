//! N-API bindings for the Codex live WebRTC peer.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! the realtime peer, microphone capture, Opus media, audio processing and
//! speaker playback live in `pi_voice::live`. This class adapts its callbacks
//! to non-blocking threadsafe functions, and mirrors its settings and
//! diagnostics as N-API objects.
//!
//! Audio never crosses this boundary: capture is clocked by the device inside
//! the engine, so there is no `push_audio`.

use std::sync::Arc;

use napi::{
	bindgen_prelude::Result,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use pi_voice::live::{
	DEFAULT_OPEN_TIMEOUT_MS,
	LiveAgcMode as EngineAgcMode,
	LiveAudioProcessingConfig as EngineAudioProcessingConfig,
	LiveCallbacks,
	LiveEchoCancellationMode as EngineEchoCancellationMode,
	LiveNoiseSuppressionLevel as EngineNoiseSuppressionLevel,
	LivePeerCore,
	live_audio_processing_available as engine_audio_processing_available,
};

type StringCallback = ThreadsafeFunction<String, UnknownReturnValue>;
type LevelCallback = ThreadsafeFunction<f64, UnknownReturnValue>;

/// Echo-cancellation algorithm.
///
/// A closed enum rather than a string: an unrecognized value used to fall
/// through a wildcard and silently disable the stage, so a renamed or mistyped
/// wire value degraded the call instead of failing at the boundary.
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveEchoCancellationMode {
	Off,
	/// AEC3, which estimates the render-to-capture delay itself.
	Full,
	/// AECM, which has no estimator and needs the real end-to-end delay.
	Mobile,
}

/// Noise-suppression aggressiveness.
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveNoiseSuppressionLevel {
	Off,
	Low,
	Moderate,
	High,
	VeryHigh,
}

/// Digital gain-control mode.
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveAgcMode {
	Off,
	AdaptiveDigital,
	FixedDigital,
}

/// Typed audio-processing settings resolved by the TypeScript host.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct LiveAudioProcessingConfig {
	pub echo_cancellation:       LiveEchoCancellationMode,
	/// Render-to-capture delay in milliseconds; zero requests estimation.
	pub echo_delay_ms:           u32,
	pub noise_suppression:       LiveNoiseSuppressionLevel,
	pub agc:                     LiveAgcMode,
	/// Digital gain-control target below full scale.
	pub agc_target_level_dbfs:   u32,
	/// Maximum digital compression gain in decibels.
	pub agc_compression_gain_db: u32,
	/// Whether processed capture is limited to the target level.
	pub agc_limiter:             bool,
}

impl From<LiveEchoCancellationMode> for EngineEchoCancellationMode {
	fn from(mode: LiveEchoCancellationMode) -> Self {
		match mode {
			LiveEchoCancellationMode::Off => Self::Off,
			LiveEchoCancellationMode::Full => Self::Full,
			LiveEchoCancellationMode::Mobile => Self::Mobile,
		}
	}
}

impl From<LiveNoiseSuppressionLevel> for EngineNoiseSuppressionLevel {
	fn from(level: LiveNoiseSuppressionLevel) -> Self {
		match level {
			LiveNoiseSuppressionLevel::Off => Self::Off,
			LiveNoiseSuppressionLevel::Low => Self::Low,
			LiveNoiseSuppressionLevel::Moderate => Self::Moderate,
			LiveNoiseSuppressionLevel::High => Self::High,
			LiveNoiseSuppressionLevel::VeryHigh => Self::VeryHigh,
		}
	}
}

impl From<LiveAgcMode> for EngineAgcMode {
	fn from(mode: LiveAgcMode) -> Self {
		match mode {
			LiveAgcMode::Off => Self::Off,
			LiveAgcMode::AdaptiveDigital => Self::AdaptiveDigital,
			LiveAgcMode::FixedDigital => Self::FixedDigital,
		}
	}
}

impl From<LiveAudioProcessingConfig> for EngineAudioProcessingConfig {
	fn from(config: LiveAudioProcessingConfig) -> Self {
		Self {
			echo_cancellation:       config.echo_cancellation.into(),
			echo_delay_ms:           config.echo_delay_ms,
			noise_suppression:       config.noise_suppression.into(),
			agc:                     config.agc.into(),
			agc_target_level_dbfs:   config.agc_target_level_dbfs,
			agc_compression_gain_db: config.agc_compression_gain_db,
			agc_limiter:             config.agc_limiter,
		}
	}
}

/// Monotonic media counters for one live peer.
///
/// Every value resets when a peer is constructed, so a call's diagnostics
/// describe only that call. Nothing here carries audio, transcripts, or
/// signaling content.
#[napi(object)]
pub struct LiveAudioDiagnostics {
	/// Opus packets encoded from real capture audio.
	pub input_frames:                i64,
	/// Frames whose samples were replaced with silence because input was muted.
	pub input_silence_padded_frames: i64,
	/// Capture samples dropped after unencoded audio exceeded its 250 ms cap.
	pub input_dropped_samples:       i64,
	/// High-water mark of unencoded capture audio, in samples.
	pub max_queued_input_samples:    i64,
	/// RTP packets accepted into the playout buffer.
	pub output_packets:              i64,
	/// Distinct runs of missing RTP sequence numbers.
	pub output_sequence_gaps:        i64,
	/// Frames synthesized by FEC or PLC rather than decoded from a packet.
	pub output_concealed_frames:     i64,
	/// Remote samples discarded for missing their deadline or overflowing.
	pub output_dropped_samples:      i64,
	/// Speaker callbacks that ran dry mid-stream.
	pub playback_underruns:          i64,
	/// High-water mark of the speaker render ring, in samples.
	pub max_playback_queued_samples: i64,
	/// Whether audio processing is actively running for this call.
	pub audio_processing_active:     bool,
	/// Sanitized negotiated codec summary, available after the SDP answer.
	pub codec_summary:               Option<String>,
}

impl From<pi_voice::live::LiveAudioDiagnostics> for LiveAudioDiagnostics {
	fn from(value: pi_voice::live::LiveAudioDiagnostics) -> Self {
		Self {
			input_frames:                value.input_frames,
			input_silence_padded_frames: value.input_silence_padded_frames,
			input_dropped_samples:       value.input_dropped_samples,
			max_queued_input_samples:    value.max_queued_input_samples,
			output_packets:              value.output_packets,
			output_sequence_gaps:        value.output_sequence_gaps,
			output_concealed_frames:     value.output_concealed_frames,
			output_dropped_samples:      value.output_dropped_samples,
			playback_underruns:          value.playback_underruns,
			max_playback_queued_samples: value.max_playback_queued_samples,
			audio_processing_active:     value.audio_processing_active,
			codec_summary:               value.codec_summary,
		}
	}
}

/// Whether this build links a real audio-processing implementation.
#[napi]
pub const fn live_audio_processing_available() -> bool {
	engine_audio_processing_available()
}

/// WebRTC peer that owns microphone capture and renders remote Opus audio.
#[napi]
pub struct LiveWebRtcPeer {
	inner: Arc<LivePeerCore>,
}

#[napi]
impl LiveWebRtcPeer {
	/// Create an idle peer and register its event, level, and failure
	/// callbacks.
	#[napi(constructor)]
	pub fn new(
		#[napi(ts_arg_type = "(error: Error | null, payload: string) => void")]
		on_event: StringCallback,
		#[napi(ts_arg_type = "(error: Error | null, level: number) => void")]
		on_input_level: LevelCallback,
		#[napi(ts_arg_type = "(error: Error | null, level: number) => void")]
		on_output_level: LevelCallback,
		#[napi(ts_arg_type = "(error: Error | null, message: string) => void")]
		on_failure: StringCallback,
		audio_processing: LiveAudioProcessingConfig,
		input_device_id: Option<String>,
		output_device_id: Option<String>,
	) -> Self {
		let config: EngineAudioProcessingConfig = audio_processing.into();
		Self {
			inner: Arc::new(LivePeerCore::new(
				LiveCallbacks {
					event:       Box::new(move |payload| {
						on_event.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
					}),
					input_level: Box::new(move |level| {
						on_input_level.call(Ok(level), ThreadsafeFunctionCallMode::NonBlocking);
					}),
					level:       Box::new(move |level| {
						on_output_level.call(Ok(level), ThreadsafeFunctionCallMode::NonBlocking);
					}),
					failure:     Box::new(move |message| {
						on_failure.call(Ok(message), ThreadsafeFunctionCallMode::NonBlocking);
					}),
				},
				&config,
				input_device_id.unwrap_or_default(),
				output_device_id.unwrap_or_default(),
			)),
		}
	}

	/// Start the native media peer, open the microphone, and return its SDP
	/// offer.
	#[napi]
	pub async fn create_offer(&self) -> Result<String> {
		self
			.inner
			.create_offer()
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Apply the remote SDP answer returned by Codex signaling.
	#[napi]
	pub async fn accept_answer(&self, sdp: String) -> Result<()> {
		self
			.inner
			.accept_answer(sdp)
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Wait until the `oai-events` data channel is open.
	#[napi]
	pub async fn wait_for_open(&self, timeout_ms: Option<u32>) -> Result<()> {
		self
			.inner
			.wait_for_open(timeout_ms.unwrap_or(DEFAULT_OPEN_TIMEOUT_MS))
			.await
			.map_err(napi::Error::from_reason)
	}

	/// Release audio retained before activation and begin transmitting.
	#[napi]
	pub fn activate(&self) -> Result<()> {
		self.inner.activate().map_err(napi::Error::from_reason)
	}

	/// Enable or disable microphone transmission; muted capture sends silence.
	#[napi]
	pub fn set_muted(&self, muted: bool) -> Result<()> {
		self
			.inner
			.set_muted(muted)
			.map_err(napi::Error::from_reason)
	}

	/// Enable or disable speaker playback without closing the remote track.
	#[napi]
	pub fn set_output_muted(&self, muted: bool) {
		self.inner.set_output_muted(muted);
	}

	/// Reopen the microphone, optionally switching to another input device.
	#[napi]
	pub fn refresh_microphone(&self, input_device_id: Option<String>) -> Result<()> {
		self
			.inner
			.refresh_microphone(input_device_id)
			.map_err(napi::Error::from_reason)
	}

	/// Read this call's monotonic media counters and negotiated codec summary.
	#[napi]
	pub fn get_diagnostics(&self) -> LiveAudioDiagnostics {
		self.inner.diagnostics().into()
	}

	/// Close media, the data channel, the peer connection, and speaker
	/// playback.
	#[napi]
	pub async fn close(&self) {
		self.inner.close().await;
	}
}

impl Drop for LiveWebRtcPeer {
	fn drop(&mut self) {
		if self.inner.is_closing() {
			return;
		}
		let inner = Arc::clone(&self.inner);
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			runtime.spawn(async move {
				inner.close().await;
			});
		}
	}
}
