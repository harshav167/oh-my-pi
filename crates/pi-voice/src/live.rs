//! Native WebRTC media transport for Codex live conversations.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! this module owns the realtime WebRTC peer, microphone capture, Opus media,
//! audio processing, and speaker playback. Audio never crosses the N-API
//! boundary: the capture device clocks encoding directly, and remote RTP is
//! reordered into a bounded adaptive playout before it reaches the speaker.

mod apm;
mod framer;
mod input;
mod output;
mod playout;

use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
	},
	time::Duration,
};

use parking_lot::Mutex;
use tokio::{
	sync::{Notify, watch},
	task::JoinHandle,
};
use webrtc::{
	api::{
		APIBuilder,
		interceptor_registry::register_default_interceptors,
		media_engine::{MIME_TYPE_OPUS, MediaEngine},
	},
	data_channel::{RTCDataChannel, data_channel_message::DataChannelMessage},
	interceptor::registry::Registry,
	peer_connection::{
		RTCPeerConnection, configuration::RTCConfiguration,
		peer_connection_state::RTCPeerConnectionState,
		sdp::session_description::RTCSessionDescription,
	},
	rtp_transceiver::{
		rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
		rtp_sender::RTCRtpSender,
	},
	track::track_local::{TrackLocal, track_local_static_sample::TrackLocalStaticSample},
};

pub use self::apm::{
	LiveAgcMode,
	LiveAudioProcessingConfig,
	LiveEchoCancellationMode,
	LiveNoiseSuppressionLevel,
	live_audio_processing_available,
};
use self::{
	apm::AudioProcessing,
	framer::CaptureQueue,
	input::{InputCommand, run_input_audio},
	output::receive_output_audio,
};
use crate::audio::{CaptureStream, PlaybackStream, PlaybackWriter};

const DATA_CHANNEL_LABEL: &str = "oai-events";
/// Every stage of the live pipeline runs at 48 kHz mono.
const AUDIO_SAMPLE_RATE: u32 = 48_000;
/// One Opus packet covers 20 ms.
const OPUS_FRAME_DURATION: Duration = Duration::from_millis(20);
const MAX_ENCODED_OPUS_BYTES: usize = 1_275;
/// Advertised packet-loss percentage; enabling it is what turns on in-band FEC.
const OPUS_PACKET_LOSS_PERC: i32 = 10;
/// 250 ms of speaker audio, matching the playout buffer's own ceiling.
const PLAYBACK_RING_SAMPLES: usize = 12_000;
/// Playout scheduler period.
const PLAYOUT_TICK: Duration = Duration::from_millis(10);
/// Speaker-side cushion against scheduler drift; the adaptive delay already
/// lives in the playout buffer, so this stays deliberately small.
const PLAYBACK_CUSHION_SAMPLES: usize = 960;
/// Latency between `analyze_render` and the speaker: the ring cushion plus the
/// device's own output period. The adaptive playout target has already elapsed
/// by then, so it is deliberately excluded.
const RENDER_LATENCY_MS: u32 =
	(PLAYBACK_CUSHION_SAMPLES as u32) * 1_000 / AUDIO_SAMPLE_RATE + crate::audio::AUDIO_PERIOD_MS;
/// Silence from an active, unmuted microphone that counts as a stalled device.
const CAPTURE_STALL_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_OPEN_TIMEOUT_MS: u32 = 20_000;
const DISCONNECT_GRACE: Duration = Duration::from_secs(2);
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(1);

pub type StringCallback = Box<dyn Fn(String) + Send + Sync>;
pub type LevelCallback = Box<dyn Fn(f64) + Send + Sync>;
/// Engine-level result, shared with the rest of the crate.
pub type NativeResult<T> = crate::VoiceResult<T>;

/// Monotonic media counters for one live peer.
///
/// Every value resets when a peer is constructed, so a call's diagnostics
/// describe only that call. Nothing here carries audio, transcripts, or
/// signaling content.
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

#[derive(Default)]
struct Counters {
	input_frames:                AtomicU64,
	input_silence_padded_frames: AtomicU64,
	input_dropped_samples:       AtomicU64,
	max_queued_input_samples:    AtomicUsize,
	output_packets:              AtomicU64,
	output_sequence_gaps:        AtomicU64,
	output_concealed_frames:     AtomicU64,
	output_dropped_samples:      AtomicU64,
	playback_underruns:          AtomicU64,
	max_playback_queued_samples: AtomicUsize,
}

#[derive(Clone, Debug)]
enum PeerSignal {
	Connecting,
	Open,
	Failed(String),
	Closed,
}

pub struct LiveCallbacks {
	pub event:       StringCallback,
	pub input_level: LevelCallback,
	pub level:       LevelCallback,
	pub failure:     StringCallback,
}

struct LiveResources {
	peer:         Arc<RTCPeerConnection>,
	data_channel: Arc<RTCDataChannel>,
	input_tx:     flume::Sender<InputCommand>,
	input_task:   JoinHandle<()>,
	rtcp_task:    JoinHandle<()>,
	playback:     PlaybackStream,
	capture:      Mutex<Option<CaptureStream>>,
}

pub struct LivePeerCore {
	callbacks:        LiveCallbacks,
	resources:        Mutex<Option<LiveResources>>,
	signal_tx:        watch::Sender<PeerSignal>,
	started:          AtomicBool,
	closing:          AtomicBool,
	muted:            Arc<AtomicBool>,
	output_muted:     AtomicBool,
	failure_reported: AtomicBool,
	counters:         Counters,
	processing:       AudioProcessing,
	codec_summary:    Mutex<Option<String>>,
	capture_queue:    Arc<Mutex<CaptureQueue>>,
	capture_wake:     Arc<Notify>,
	playback_writer:  Mutex<Option<PlaybackWriter>>,
	input_device_id:  Mutex<String>,
	output_device_id: String,
}

impl LivePeerCore {
	pub fn new(
		callbacks: LiveCallbacks,
		config: &LiveAudioProcessingConfig,
		input_device_id: String,
		output_device_id: String,
	) -> Self {
		let (signal_tx, _) = watch::channel(PeerSignal::Connecting);
		let (processing, failure) = AudioProcessing::new(config, RENDER_LATENCY_MS);
		let core = Self {
			callbacks,
			resources: Mutex::new(None),
			signal_tx,
			started: AtomicBool::new(false),
			closing: AtomicBool::new(false),
			muted: Arc::new(AtomicBool::new(false)),
			output_muted: AtomicBool::new(false),
			failure_reported: AtomicBool::new(false),
			counters: Counters::default(),
			processing,
			codec_summary: Mutex::new(None),
			capture_queue: Arc::new(Mutex::new(CaptureQueue::default())),
			capture_wake: Arc::new(Notify::new()),
			playback_writer: Mutex::new(None),
			input_device_id: Mutex::new(input_device_id),
			output_device_id,
		};
		if let Some(failure) = failure {
			// Degraded audio beats a dropped call: report once and keep going.
			core.report_processing_bypass(&failure);
		}
		core
	}

	/// Emit a nonterminal diagnostic without disturbing connected media.
	fn report_diagnostic(&self, message: &str) {
		(self.callbacks.event)(format!(
			r#"{{"type":"live.diagnostic","message":{}}}"#,
			serde_json::Value::String(message.to_owned())
		));
	}

	fn report_processing_bypass(&self, reason: &str) {
		self.report_diagnostic(reason);
	}

	fn report_capture_stalled(&self) {
		self.report_diagnostic("Live microphone capture stalled");
	}

	pub async fn create_offer(self: &Arc<Self>) -> NativeResult<String> {
		if self.started.swap(true, Ordering::AcqRel) {
			return Err("Native live WebRTC peer has already started".to_owned());
		}
		if self.closing.load(Ordering::Acquire) {
			return Err("Native live WebRTC peer is closed".to_owned());
		}

		let level_core = Arc::downgrade(self);
		let playback = PlaybackStream::start(
			AUDIO_SAMPLE_RATE,
			&self.output_device_id,
			PLAYBACK_RING_SAMPLES,
			Some(Arc::new(move |level| {
				if let Some(core) = level_core.upgrade() {
					core.report_level(level);
				}
			})),
		)?;
		let playback_tx = playback.writer()?;
		let mut media_engine = MediaEngine::default();
		let capability = opus_capability();
		media_engine
			.register_codec(
				RTCRtpCodecParameters {
					capability: capability.clone(),
					payload_type: 111,
					..Default::default()
				},
				RTPCodecType::Audio,
			)
			.map_err(|error| format!("Failed to register the live Opus codec: {error}"))?;
		let registry = register_default_interceptors(Registry::new(), &mut media_engine)
			.map_err(|error| format!("Failed to configure live WebRTC interceptors: {error}"))?;
		let api = APIBuilder::new()
			.with_media_engine(media_engine)
			.with_interceptor_registry(registry)
			.build();
		let peer = Arc::new(
			api.new_peer_connection(RTCConfiguration::default())
				.await
				.map_err(|error| format!("Failed to create the live WebRTC peer: {error}"))?,
		);

		// Every step past peer creation can fail, and each one used to repeat its
		// own `peer.close()` branch. Staged in one fallible helper instead, so the
		// close lives here exactly once.
		let staged = self
			.stage_peer(&peer, capability, playback_tx.clone())
			.await;
		let (track, sender, data_channel, offer) = match staged {
			Ok(staged) => staged,
			Err(error) => {
				let _ = peer.close().await;
				return Err(error);
			},
		};

		let mut resources_slot = self.resources.lock();
		let capture = if self.closing.load(Ordering::Acquire) {
			Err("Native live WebRTC peer was closed while starting".to_owned())
		} else {
			self.open_capture()
		};
		let capture = match capture {
			Ok(capture) => capture,
			Err(error) => {
				drop(resources_slot);
				let _ = peer.close().await;
				return Err(error);
			},
		};

		let (input_tx, input_rx) = flume::unbounded();
		let input_task = tokio::spawn(run_input_audio(
			track,
			input_rx,
			Arc::clone(&self.capture_queue),
			Arc::clone(&self.capture_wake),
			Arc::downgrade(self),
		));
		let rtcp_task = tokio::spawn(drain_rtcp(sender));
		*resources_slot = Some(LiveResources {
			peer,
			data_channel,
			input_tx,
			input_task,
			rtcp_task,
			playback,
			capture: Mutex::new(Some(capture)),
		});
		// Published only now: a writer visible while `resources` is still empty is
		// a half-started peer, and callers reading it would write into a call that
		// never came up.
		*self.playback_writer.lock() = Some(playback_tx);
		Ok(offer.sdp)
	}

	/// Wire the track, callbacks, data channel, and local SDP onto a fresh peer.
	///
	/// Fallible from start to finish and owns no cleanup: the caller closes the
	/// peer once if any step here fails, which is why every step can use `?`.
	async fn stage_peer(
		self: &Arc<Self>,
		peer: &Arc<RTCPeerConnection>,
		capability: RTCRtpCodecCapability,
		playback_tx: PlaybackWriter,
	) -> NativeResult<(
		Arc<TrackLocalStaticSample>,
		Arc<RTCRtpSender>,
		Arc<RTCDataChannel>,
		RTCSessionDescription,
	)> {
		let track = Arc::new(TrackLocalStaticSample::new(
			capability,
			"audio".to_owned(),
			"omp-live".to_owned(),
		));
		let sender = peer
			.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
			.await
			.map_err(|error| format!("Failed to add the live audio track: {error}"))?;
		install_peer_callbacks(peer, Arc::downgrade(self), playback_tx);
		let data_channel = peer
			.create_data_channel(DATA_CHANNEL_LABEL, None)
			.await
			.map_err(|error| format!("Failed to create the live data channel: {error}"))?;
		install_data_channel_callbacks(&data_channel, Arc::downgrade(self));
		let offer = peer
			.create_offer(None)
			.await
			.map_err(|error| format!("Failed to create the live SDP offer: {error}"))?;
		peer
			.set_local_description(offer.clone())
			.await
			.map_err(|error| format!("Failed to install the live SDP offer: {error}"))?;
		Ok((track, sender, data_channel, offer))
	}

	/// Open the configured microphone, writing borrowed blocks straight into
	/// the bounded capture ring the encoder task drains.
	fn open_capture(&self) -> NativeResult<CaptureStream> {
		let device_id = self.input_device_id.lock().clone();
		let queue = Arc::clone(&self.capture_queue);
		let wake = Arc::clone(&self.capture_wake);
		let muted = Arc::clone(&self.muted);
		CaptureStream::start(AUDIO_SAMPLE_RATE, &device_id, move |samples| {
			queue.lock().push(samples, muted.load(Ordering::Acquire));
			wake.notify_one();
		})
	}

	pub async fn accept_answer(&self, sdp: String) -> NativeResult<()> {
		let peer = self
			.resources
			.lock()
			.as_ref()
			.map(|resources| Arc::clone(&resources.peer))
			.ok_or_else(|| "Native live WebRTC peer has not started".to_owned())?;
		let answer = RTCSessionDescription::answer(sdp)
			.map_err(|error| format!("Codex returned an invalid live SDP answer: {error}"))?;
		peer
			.set_remote_description(answer)
			.await
			.map_err(|error| format!("Failed to install the live SDP answer: {error}"))?;
		*self.codec_summary.lock() = Some(negotiated_codec_summary(&peer).await);
		Ok(())
	}

	pub async fn wait_for_open(&self, timeout_ms: u32) -> NativeResult<()> {
		let mut signal_rx = self.signal_tx.subscribe();
		let wait = async {
			loop {
				let signal = signal_rx.borrow().clone();
				match signal {
					PeerSignal::Open => return Ok(()),
					PeerSignal::Failed(message) => return Err(message),
					PeerSignal::Closed => {
						return Err("Native live WebRTC peer closed before opening".to_owned());
					},
					PeerSignal::Connecting => {},
				}
				signal_rx
					.changed()
					.await
					.map_err(|_| "Native live WebRTC peer stopped before opening".to_owned())?;
			}
		};
		tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), wait)
			.await
			.map_err(|_| "Timed out waiting for the live data channel to open".to_owned())?
	}

	fn send_input(&self, command: InputCommand) -> NativeResult<()> {
		let input_tx = self
			.resources
			.lock()
			.as_ref()
			.map(|resources| resources.input_tx.clone())
			.ok_or_else(|| "Native live WebRTC peer has not started".to_owned())?;
		input_tx
			.send(command)
			.map_err(|_| "Native live audio input is closed".to_owned())
	}

	/// Release retained startup audio and begin transmitting.
	///
	/// The command is the single activation point: the encoder task activates
	/// the queue when it receives it, so a failed send leaves nothing half-done.
	pub fn activate(&self) -> NativeResult<()> {
		self.send_input(InputCommand::Activate)
	}

	pub fn set_muted(&self, muted: bool) -> NativeResult<()> {
		self.muted.store(muted, Ordering::Release);
		self.send_input(InputCommand::Muted(muted))
	}

	pub fn set_output_muted(&self, muted: bool) {
		self.output_muted.store(muted, Ordering::Release);
		if let Some(writer) = self.playback_writer.lock().as_ref() {
			writer.set_muted(muted);
		}
	}

	/// Reopen the microphone, optionally switching to a different device.
	pub fn refresh_microphone(&self, input_device_id: Option<String>) -> NativeResult<()> {
		if let Some(input_device_id) = input_device_id {
			*self.input_device_id.lock() = input_device_id;
		}
		let resources = self.resources.lock();
		let resources = resources
			.as_ref()
			.ok_or_else(|| "Native live WebRTC peer has not started".to_owned())?;
		let mut slot = resources.capture.lock();
		if let Some(mut previous) = slot.take() {
			previous.stop()?;
		}
		*slot = Some(self.open_capture()?);
		// A reopened device restarts the stall detector from its first callback.
		self.capture_wake.notify_one();
		Ok(())
	}

	pub fn diagnostics(&self) -> LiveAudioDiagnostics {
		let counters = &self.counters;
		let writer = self.playback_writer.lock().clone();
		let (underruns, dropped, max_queued) = writer.as_ref().map_or_else(
			|| {
				(
					counters.playback_underruns.load(Ordering::Relaxed),
					0,
					counters.max_playback_queued_samples.load(Ordering::Relaxed),
				)
			},
			|writer| (writer.underruns(), writer.dropped_samples(), writer.max_queued_samples()),
		);
		LiveAudioDiagnostics {
			input_frames:                counters.input_frames.load(Ordering::Relaxed) as i64,
			input_silence_padded_frames: counters.input_silence_padded_frames.load(Ordering::Relaxed)
				as i64,
			input_dropped_samples:       counters.input_dropped_samples.load(Ordering::Relaxed) as i64,
			max_queued_input_samples:    counters.max_queued_input_samples.load(Ordering::Relaxed)
				as i64,
			output_packets:              counters.output_packets.load(Ordering::Relaxed) as i64,
			output_sequence_gaps:        counters.output_sequence_gaps.load(Ordering::Relaxed) as i64,
			output_concealed_frames:     counters.output_concealed_frames.load(Ordering::Relaxed)
				as i64,
			output_dropped_samples:      (counters.output_dropped_samples.load(Ordering::Relaxed)
				+ dropped) as i64,
			playback_underruns:          underruns as i64,
			max_playback_queued_samples: max_queued as i64,
			audio_processing_active:     self.processing.active(),
			codec_summary:               self.codec_summary.lock().clone(),
		}
	}

	fn report_event(&self, payload: String) {
		(self.callbacks.event)(payload);
	}

	fn report_input_level(&self, level: f64) {
		(self.callbacks.input_level)(level.clamp(0.0, 1.0));
	}

	fn report_level(&self, level: f64) {
		(self.callbacks.level)(level.clamp(0.0, 1.0));
	}

	fn mark_open(&self) {
		if !self.closing.load(Ordering::Acquire) {
			self.signal_tx.send_replace(PeerSignal::Open);
		}
	}

	fn report_failure(&self, message: String) {
		if self.closing.load(Ordering::Acquire) || self.failure_reported.swap(true, Ordering::AcqRel)
		{
			return;
		}
		self
			.signal_tx
			.send_replace(PeerSignal::Failed(message.clone()));
		(self.callbacks.failure)(message);
	}

	/// Whether `close` has already been entered; the N-API adapter's `Drop`
	/// uses this to avoid scheduling a second teardown.
	pub fn is_closing(&self) -> bool {
		self.closing.load(Ordering::Acquire)
	}

	pub async fn close(&self) {
		if self.closing.swap(true, Ordering::AcqRel) {
			let mut signal_rx = self.signal_tx.subscribe();
			while !matches!(*signal_rx.borrow(), PeerSignal::Closed) {
				if signal_rx.changed().await.is_err() {
					break;
				}
			}
			return;
		}

		let resources = self.resources.lock().take();
		if let Some(mut resources) = resources {
			let capture = resources.capture.lock().take();
			if let Some(mut capture) = capture {
				let _ = capture.stop();
			}
			let _ = resources.input_tx.send(InputCommand::Close);
			let _ = resources.peer.close().await;
			let writer = self.playback_writer.lock().take();
			if let Some(writer) = writer {
				self
					.counters
					.playback_underruns
					.store(writer.underruns(), Ordering::Relaxed);
				self
					.counters
					.max_playback_queued_samples
					.store(writer.max_queued_samples(), Ordering::Relaxed);
				self
					.counters
					.output_dropped_samples
					.fetch_add(writer.dropped_samples(), Ordering::Relaxed);
			}
			let _ = resources.playback.stop();
			let _ = tokio::time::timeout(CLOSE_TASK_TIMEOUT, resources.input_task).await;
			resources.rtcp_task.abort();
			let _ = resources.rtcp_task.await;
			drop(resources.data_channel);
		}
		self.signal_tx.send_replace(PeerSignal::Closed);
	}
}

/// RFC 7587 requires Opus to be signaled as `opus/48000/2` even when both
/// endpoints encode mono, so the SDP channel count stays 2 while every codec
/// instance below remains mono.
fn opus_capability() -> RTCRtpCodecCapability {
	RTCRtpCodecCapability {
		mime_type:     MIME_TYPE_OPUS.to_owned(),
		clock_rate:    AUDIO_SAMPLE_RATE,
		channels:      2,
		sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
		rtcp_feedback: Vec::new(),
	}
}

/// Summarize the negotiated audio codec without exposing SDP or media.
async fn negotiated_codec_summary(peer: &Arc<RTCPeerConnection>) -> String {
	for transceiver in peer.get_transceivers().await {
		if transceiver.kind() != RTPCodecType::Audio {
			continue;
		}
		let codecs = transceiver.receiver().await.get_parameters().await.codecs;
		if let Some(codec) = codecs.into_iter().next() {
			return format!(
				"{} {} Hz / {} ch, pt {}, fmtp[{}]",
				codec.capability.mime_type,
				codec.capability.clock_rate,
				codec.capability.channels,
				codec.payload_type,
				codec.capability.sdp_fmtp_line.len()
			);
		}
	}
	"no negotiated audio codec".to_owned()
}

fn install_peer_callbacks(
	peer: &Arc<RTCPeerConnection>,
	core: Weak<LivePeerCore>,
	playback_tx: PlaybackWriter,
) {
	let output_sender = Arc::new(Mutex::new(Some(playback_tx)));
	let output_sender_for_track = Arc::clone(&output_sender);
	let core_for_track = core.clone();
	peer.on_track(Box::new(move |track, _receiver, _transceiver| {
		let output_sender = output_sender_for_track.lock().take();
		let core = core_for_track.clone();
		Box::pin(async move {
			if track.kind() != RTPCodecType::Audio {
				return;
			}
			let Some(output_sender) = output_sender else {
				if let Some(core) = core.upgrade() {
					core.report_failure(
						"Codex live returned more than one remote audio track".to_owned(),
					);
				}
				return;
			};
			tokio::spawn(receive_output_audio(track, output_sender, core));
		})
	}));

	let peer_for_state = Arc::downgrade(peer);
	peer.on_peer_connection_state_change(Box::new(move |state| {
		let core = core.clone();
		let peer = peer_for_state.clone();
		Box::pin(async move {
			let Some(core) = core.upgrade() else {
				return;
			};
			match state {
				RTCPeerConnectionState::Failed => {
					core.report_failure("Live WebRTC peer connection failed".to_owned());
				},
				RTCPeerConnectionState::Closed if !core.closing.load(Ordering::Acquire) => {
					core.report_failure("Live WebRTC peer connection closed unexpectedly".to_owned());
				},
				RTCPeerConnectionState::Disconnected => {
					tokio::time::sleep(DISCONNECT_GRACE).await;
					if peer.upgrade().is_some_and(|peer| {
						peer.connection_state() == RTCPeerConnectionState::Disconnected
					}) {
						core.report_failure("Live WebRTC peer connection disconnected".to_owned());
					}
				},
				_ => {},
			}
		})
	}));
}

fn install_data_channel_callbacks(data_channel: &Arc<RTCDataChannel>, core: Weak<LivePeerCore>) {
	let core_for_open = core.clone();
	data_channel.on_open(Box::new(move || {
		Box::pin(async move {
			if let Some(core) = core_for_open.upgrade() {
				core.mark_open();
			}
		})
	}));

	let core_for_message = core.clone();
	data_channel.on_message(Box::new(move |message: DataChannelMessage| {
		let core = core_for_message.clone();
		Box::pin(async move {
			if !message.is_string {
				return;
			}
			if let (Some(core), Ok(payload)) =
				(core.upgrade(), String::from_utf8(message.data.to_vec()))
			{
				core.report_event(payload);
			}
		})
	}));

	let core_for_close = core.clone();
	data_channel.on_close(Box::new(move || {
		let core = core_for_close.clone();
		Box::pin(async move {
			if let Some(core) = core.upgrade() {
				core.report_failure("Live data channel closed unexpectedly".to_owned());
			}
		})
	}));

	data_channel.on_error(Box::new(move |error| {
		let core = core.clone();
		Box::pin(async move {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Live data channel failed: {error}"));
			}
		})
	}));
}

async fn drain_rtcp(sender: Arc<RTCRtpSender>) {
	while sender.read_rtcp().await.is_ok() {}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn opus_is_signaled_as_rfc7587_stereo_while_codecs_stay_mono() {
		let capability = opus_capability();

		assert_eq!(capability.clock_rate, 48_000);
		assert_eq!(capability.channels, 2, "RFC 7587 requires opus/48000/2 signaling");
		assert!(capability.sdp_fmtp_line.contains("useinbandfec=1"));
	}
}
