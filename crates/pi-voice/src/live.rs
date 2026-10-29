//! Native WebRTC media transport for Codex live conversations.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! this module owns the realtime WebRTC peer, Opus media, and speaker
//! playback. The N-API class in pi-natives is a thin adapter over
//! [`LivePeerCore`].

mod playout;
mod processing;
mod runtime;

use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};

use parking_lot::Mutex;
use tokio::{sync::watch, task::JoinHandle};
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

use crate::{
	VoiceResult,
	audio::{CaptureStream, PlaybackStream, set_epoch_disabled},
};

const DATA_CHANNEL_LABEL: &str = "oai-events";
const OUTPUT_SAMPLE_RATE: u32 = 48_000;
/// Default `wait_for_open` timeout, exposed so the N-API adapter can apply it
/// when TypeScript passes no override.
pub const DEFAULT_OPEN_TIMEOUT_MS: u32 = 20_000;
const DISCONNECT_GRACE: Duration = Duration::from_secs(2);
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(1);

const OPUS_CAPABILITY: RTCRtpCodecCapability = RTCRtpCodecCapability {
	mime_type:     String::new(),
	clock_rate:    OUTPUT_SAMPLE_RATE,
	channels:      2,
	sdp_fmtp_line: String::new(),
	rtcp_feedback: Vec::new(),
};

#[derive(Clone, Debug)]
enum PeerSignal {
	Connecting,
	Open,
	Failed(String),
	Closed,
}

#[derive(Clone, Copy, PartialEq)]
struct LiveLevels {
	input:  f64,
	output: f64,
}

/// Host callbacks for peer lifecycle and media events. Callbacks must not
/// block or call back into the peer; the N-API adapter forwards through
/// non-blocking threadsafe functions.
///
/// - `event` runs on tokio worker threads.
/// - `levels` runs on the media worker and, when muting or suppressing the
///   speaker, on the thread calling [`LivePeerCore::set_muted`] or
///   [`LivePeerCore::set_speaker_suppressed`]. It runs while the peer's level
///   lock (and, from those setters, its resource lock) is held, so re-entering
///   the peer deadlocks.
/// - `failure` runs on tokio worker threads, or on the realtime device audio
///   threads when a microphone or speaker-reference queue closes unexpectedly.
pub struct LiveCallbacks {
	/// One `oai-events` data-channel text payload.
	pub event:   Box<dyn Fn(String) + Send + Sync>,
	/// RMS input and output levels in `[0, 1]`.
	pub levels:  Box<dyn Fn(f64, f64) + Send + Sync>,
	/// Terminal transport failure; reported at most once per peer.
	pub failure: Box<dyn Fn(String) + Send + Sync>,
}

struct LiveResources {
	peer:         Arc<RTCPeerConnection>,
	data_channel: Arc<RTCDataChannel>,
	media_tx:     flume::Sender<runtime::MediaCommand>,
	capture:      CaptureStream,
	media_task:   JoinHandle<()>,
	rtcp_task:    JoinHandle<()>,
	playback:     PlaybackStream,
}

/// WebRTC live-conversation peer: captures microphone audio natively and
/// renders remote Opus audio to the default speaker. Owned as an `Arc` by the
/// N-API `LiveWebRtcPeer` wrapper.
pub struct LivePeerCore {
	callbacks:          LiveCallbacks,
	resources:          Mutex<Option<LiveResources>>,
	signal_tx:          watch::Sender<PeerSignal>,
	started:            AtomicBool,
	closing:            AtomicBool,
	/// Even while transmitting, odd while muted; advanced on every mute
	/// transition so capture tagged with an older epoch is discarded.
	microphone_epoch:   AtomicU64,
	speaker_suppressed: AtomicBool,
	capture_dropped:    AtomicBool,
	render_dropped:     AtomicBool,
	remote_track_seen:  AtomicBool,
	failure_reported:   AtomicBool,
	levels:             Mutex<LiveLevels>,
}

impl LivePeerCore {
	/// Create an idle peer with its host callbacks registered.
	pub fn new(callbacks: LiveCallbacks) -> Self {
		let (signal_tx, _) = watch::channel(PeerSignal::Connecting);
		Self {
			callbacks,
			resources: Mutex::new(None),
			signal_tx,
			started: AtomicBool::new(false),
			closing: AtomicBool::new(false),
			microphone_epoch: AtomicU64::new(0),
			speaker_suppressed: AtomicBool::new(false),
			capture_dropped: AtomicBool::new(false),
			render_dropped: AtomicBool::new(false),
			remote_track_seen: AtomicBool::new(false),
			failure_reported: AtomicBool::new(false),
			levels: Mutex::new(LiveLevels { input: 0.0, output: 0.0 }),
		}
	}

	/// Start the native media peer and return its SDP offer.
	///
	/// Fails when called twice, after close, or when the speaker, codec,
	/// peer, track, or data channel cannot be set up.
	pub async fn create_offer(self: &Arc<Self>) -> VoiceResult<String> {
		if self.started.swap(true, Ordering::AcqRel) {
			return Err("Native live WebRTC peer has already started".to_owned());
		}
		if self.closing.load(Ordering::Acquire) {
			return Err("Native live WebRTC peer is closed".to_owned());
		}

		let (reference_tx, reference_rx) = runtime::reference_channel();
		let playback = runtime::open_playback(Arc::downgrade(self), reference_tx)?;
		playback.set_suppressed(self.speaker_suppressed.load(Ordering::Acquire))?;
		let playback_tx = playback.writer()?;
		let (capture_tx, capture_rx) = runtime::capture_channel();
		let capture = runtime::open_capture(Arc::downgrade(self), capture_tx)?;
		let (packet_tx, packet_rx) = runtime::incoming_channel();
		let incoming_budget = playout::IngressBudget::new();
		let (media_tx, media_rx) = runtime::command_channel();

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

		let track = Arc::new(TrackLocalStaticSample::new(
			capability,
			"audio".to_owned(),
			"omp-live".to_owned(),
		));
		let sender = match peer
			.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
			.await
		{
			Ok(sender) => sender,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to add the live audio track: {error}"));
			},
		};

		install_peer_callbacks(&peer, Arc::downgrade(self), packet_tx, incoming_budget);
		let data_channel = match peer.create_data_channel(DATA_CHANNEL_LABEL, None).await {
			Ok(channel) => channel,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live data channel: {error}"));
			},
		};
		install_data_channel_callbacks(&data_channel, Arc::downgrade(self));

		let offer = match peer.create_offer(None).await {
			Ok(offer) => offer,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live SDP offer: {error}"));
			},
		};
		if let Err(error) = peer.set_local_description(offer.clone()).await {
			let _ = peer.close().await;
			return Err(format!("Failed to install the live SDP offer: {error}"));
		}
		let resources_result = {
			let mut resources_slot = self.resources.lock();
			if self.closing.load(Ordering::Acquire) {
				Err((
					"Native live WebRTC peer was closed while starting".to_owned(),
					peer,
					capture,
					playback,
				))
			} else if let Err(error) =
				playback.set_suppressed(self.speaker_suppressed.load(Ordering::Acquire))
			{
				Err((error, peer, capture, playback))
			} else {
				let media_task = tokio::spawn(runtime::run_media(
					Arc::clone(&track),
					capture_rx,
					reference_rx,
					packet_rx,
					media_rx,
					playback_tx,
					Arc::downgrade(self),
				));
				let rtcp_task = tokio::spawn(drain_rtcp(sender));
				*resources_slot = Some(LiveResources {
					peer,
					data_channel,
					media_tx,
					capture,
					media_task,
					rtcp_task,
					playback,
				});
				Ok(())
			}
		};
		if let Err((error, peer, mut capture, mut playback)) = resources_result {
			let _ = capture.stop();
			let _ = playback.stop();
			let _ = peer.close().await;
			return Err(error);
		}
		Ok(offer.sdp)
	}

	/// Apply the remote SDP answer returned by Codex signaling.
	pub async fn accept_answer(&self, sdp: String) -> VoiceResult<()> {
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
			.map_err(|error| format!("Failed to install the live SDP answer: {error}"))
	}

	/// Wait until the `oai-events` data channel is open, failing on peer
	/// failure, close, or timeout.
	pub async fn wait_for_open(&self, timeout_ms: u32) -> VoiceResult<()> {
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

	/// Enable or disable microphone transmission, discarding partial muted
	/// frames.
	pub fn set_muted(&self, muted: bool) -> VoiceResult<()> {
		let resources = self.resources.lock();
		if !set_epoch_disabled(&self.microphone_epoch, muted)? {
			return Ok(());
		}
		if muted {
			self.report_input_level(0.0);
		}
		if let Some(resources) = resources.as_ref() {
			resources
				.media_tx
				.send(runtime::MediaCommand::Muted(muted))
				.map_err(|_| "Native live audio input is closed".to_owned())?;
		}
		Ok(())
	}

	/// Suppress speaker output, dropping queued and incoming audio until
	/// resumed.
	pub fn set_speaker_suppressed(&self, suppressed: bool) -> VoiceResult<()> {
		let resources = self.resources.lock();
		let previous = self.speaker_suppressed.swap(suppressed, Ordering::AcqRel);
		if previous == suppressed {
			return Ok(());
		}
		if let Some(resources) = resources.as_ref() {
			if let Err(error) = resources.playback.set_suppressed(suppressed) {
				self.speaker_suppressed.store(previous, Ordering::Release);
				return Err(error);
			}
			if resources
				.media_tx
				.send(runtime::MediaCommand::SpeakerSuppressed(suppressed))
				.is_err()
			{
				return Err("Native live audio output is closed".to_owned());
			}
		}
		if suppressed {
			self.report_output_level(0.0);
		}
		Ok(())
	}

	/// Whether close has begun; lets the adapter's `Drop` skip spawning a
	/// redundant close task.
	pub fn is_closing(&self) -> bool {
		self.closing.load(Ordering::Acquire)
	}

	fn is_muted(&self) -> bool {
		!self
			.microphone_epoch
			.load(Ordering::Acquire)
			.is_multiple_of(2)
	}

	fn report_event(&self, payload: String) {
		(self.callbacks.event)(payload);
	}

	fn report_input_level(&self, input: f64) {
		let input = if self.is_muted() { 0.0 } else { input };
		self.report_levels(Some(input), None);
	}

	fn report_output_level(&self, output: f64) {
		let output = if self.speaker_suppressed.load(Ordering::Acquire) {
			0.0
		} else {
			output
		};
		self.report_levels(None, Some(output));
	}

	fn report_levels(&self, input: Option<f64>, output: Option<f64>) {
		let mut levels = self.levels.lock();
		let current = *levels;
		let next = LiveLevels {
			input:  input.map_or(current.input, normalize_level),
			output: output.map_or(current.output, normalize_level),
		};
		if current == next {
			return;
		}
		*levels = next;
		(self.callbacks.levels)(next.input, next.output);
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

	/// Close media, the data channel, the peer connection, and device streams.
	/// Concurrent calls wait for the first closer to finish.
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
			let _ = set_epoch_disabled(&self.microphone_epoch, true);
			let _ = resources.media_tx.send(runtime::MediaCommand::Close);
			let _ = resources.capture.stop();
			let _ = resources.peer.close().await;
			let _ = tokio::time::timeout(CLOSE_TASK_TIMEOUT, resources.media_task).await;
			let _ = resources.playback.stop();
			resources.rtcp_task.abort();
			let _ = resources.rtcp_task.await;
			drop(resources.data_channel);
		}
		self.signal_tx.send_replace(PeerSignal::Closed);
	}
}

const fn normalize_level(level: f64) -> f64 {
	if level.is_finite() {
		level.clamp(0.0, 1.0)
	} else {
		0.0
	}
}

fn opus_capability() -> RTCRtpCodecCapability {
	RTCRtpCodecCapability {
		mime_type:     MIME_TYPE_OPUS.to_owned(),
		clock_rate:    OPUS_CAPABILITY.clock_rate,
		channels:      OPUS_CAPABILITY.channels,
		sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
		rtcp_feedback: Vec::new(),
	}
}

fn install_peer_callbacks(
	peer: &Arc<RTCPeerConnection>,
	core: Weak<LivePeerCore>,
	incoming_tx: flume::Sender<playout::IncomingPacket>,
	budget: playout::IngressBudget,
) {
	let core_for_track = core.clone();
	peer.on_track(Box::new(move |track, _receiver, _transceiver| {
		let incoming_tx = incoming_tx.clone();
		let budget = budget.clone();
		let core = core_for_track.clone();
		Box::pin(async move {
			if track.kind() != RTPCodecType::Audio {
				return;
			}
			let Some(core_ref) = core.upgrade() else {
				return;
			};
			if core_ref.remote_track_seen.swap(true, Ordering::AcqRel) {
				core_ref
					.report_failure("Codex live returned more than one remote audio track".to_owned());
				return;
			}
			tokio::spawn(runtime::receive_output_audio(track, incoming_tx, budget, core));
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
