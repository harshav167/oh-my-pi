//! N-API bindings for the Codex live WebRTC peer.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! the realtime peer, Opus media, and device streams live in `pi_voice::live`.
//! The microphone remains native and never passes through JavaScript.

use std::sync::Arc;

use napi::{
	bindgen_prelude::Result,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use pi_voice::live::{DEFAULT_OPEN_TIMEOUT_MS, LiveCallbacks, LivePeerCore};

type StringCallback = ThreadsafeFunction<String, UnknownReturnValue>;
/// Root-mean-square microphone input and speaker output levels.
#[napi(object)]
pub struct LiveAudioLevels {
	/// Input RMS of the latest 20 ms of microphone audio after echo
	/// cancellation, noise suppression, and gain control; zero while muted.
	pub input:  f64,
	/// Output RMS of the latest 2,400 samples (50 ms) the speaker played; zero
	/// while suppressed.
	pub output: f64,
}

type LevelCallback = ThreadsafeFunction<LiveAudioLevels, UnknownReturnValue>;

/// WebRTC peer that captures the default microphone and renders remote Opus
/// audio.
#[napi]
pub struct LiveWebRtcPeer {
	inner: Arc<LivePeerCore>,
}

#[napi]
impl LiveWebRtcPeer {
	/// Create a peer and register event, input/output-level, and failure
	/// callbacks.
	#[napi(constructor)]
	pub fn new(
		#[napi(ts_arg_type = "(error: Error | null, payload: string) => void")]
		on_event: StringCallback,
		#[napi(ts_arg_type = "(error: Error | null, levels: LiveAudioLevels) => void")]
		on_levels: LevelCallback,
		#[napi(ts_arg_type = "(error: Error | null, message: string) => void")]
		on_failure: StringCallback,
	) -> Self {
		Self {
			inner: Arc::new(LivePeerCore::new(LiveCallbacks {
				event:   Box::new(move |payload| {
					on_event.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
				}),
				levels:  Box::new(move |input, output| {
					on_levels.call(
						Ok(LiveAudioLevels { input, output }),
						ThreadsafeFunctionCallMode::NonBlocking,
					);
				}),
				failure: Box::new(move |message| {
					on_failure.call(Ok(message), ThreadsafeFunctionCallMode::NonBlocking);
				}),
			})),
		}
	}

	/// Start the native media peer and return its SDP offer.
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

	/// Enable or disable microphone transmission, discarding partial muted
	/// frames.
	#[napi]
	pub fn set_muted(&self, muted: bool) -> Result<()> {
		self
			.inner
			.set_muted(muted)
			.map_err(napi::Error::from_reason)
	}

	/// While suppressed, drop queued speaker audio immediately and discard
	/// incoming audio; resume playback when unsuppressed.
	#[napi]
	pub fn set_speaker_suppressed(&self, suppressed: bool) -> Result<()> {
		self
			.inner
			.set_speaker_suppressed(suppressed)
			.map_err(napi::Error::from_reason)
	}

	/// Close the peer and release the microphone and speaker devices.
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
