use std::{
	collections::VecDeque,
	sync::{Arc, Weak},
	time::{Duration, Instant},
};

use bytes::Bytes;
use flume::{Receiver, Sender, TrySendError};
use opus::{Application, Channels, Decoder, Encoder};
use webrtc::{
	api::media_engine::MIME_TYPE_OPUS,
	media::Sample,
	track::{
		track_local::track_local_static_sample::TrackLocalStaticSample, track_remote::TrackRemote,
	},
	util::marshal::MarshalSize,
};

use super::{
	LivePeerCore,
	playout::{self, IncomingPacket, IngressBudget, JitterBuffer, JitterEvent},
	processing::{self, EncodedAudio, Processor, RmsMeter},
};
use crate::audio::{CaptureStream, PlaybackStream, PlaybackWriter};

const CAPTURE_QUEUE_CAPACITY: usize = 8;
// Fifty speaker periods: one second at 20 ms, 2.5 s at Linux's 50 ms. Either
// way it exceeds the processing deadline, so a stalled worker finds stale
// references (and resets) before the queue fills.
const REFERENCE_QUEUE_CAPACITY: usize = 50;
const MAX_PENDING_CAPTURE_PACKETS: usize = 32;
const INPUT_FRAME_DURATION: Duration = Duration::from_millis(20);
/// Longest RTP timestamp advance per empty sample: an hour of 48 kHz ticks
/// fits the packetizer's `u32` sample count.
const MAX_TIMESTAMP_ADVANCE: Duration = Duration::from_secs(3_600);
const OUTPUT_LEVEL_SAMPLES: usize = 2_400;
const OPUS_PAYLOAD_TYPE: u8 = 111;

pub(super) struct CaptureChunk {
	pub(super) samples:    Vec<f32>,
	pub(super) at:         Instant,
	pub(super) generation: u64,
}

/// Speaker output exactly as written to the device, reaching it at `at`.
pub(super) struct ReferenceFrame {
	samples: Vec<f32>,
	at:      Instant,
}

pub(super) enum MediaCommand {
	Muted(bool),
	SpeakerSuppressed(bool),
	Close,
}

pub(super) fn capture_channel() -> (Sender<CaptureChunk>, Receiver<CaptureChunk>) {
	flume::bounded(CAPTURE_QUEUE_CAPACITY)
}

pub(super) fn reference_channel() -> (Sender<ReferenceFrame>, Receiver<ReferenceFrame>) {
	flume::bounded(REFERENCE_QUEUE_CAPACITY)
}

pub(super) fn incoming_channel() -> (Sender<IncomingPacket>, Receiver<IncomingPacket>) {
	flume::bounded(playout::MAX_INCOMING_PACKETS)
}

pub(super) fn command_channel() -> (Sender<MediaCommand>, Receiver<MediaCommand>) {
	flume::unbounded()
}

pub(super) fn open_playback(
	core: Weak<LivePeerCore>,
	sender: Sender<ReferenceFrame>,
) -> crate::VoiceResult<PlaybackStream> {
	PlaybackStream::start_with_reference(
		processing::SAMPLE_RATE,
		Box::new(move |samples, at| {
			let Some(core) = core.upgrade() else {
				return;
			};
			if core.closing.load(std::sync::atomic::Ordering::Acquire) {
				return;
			}
			match sender.try_send(ReferenceFrame { samples: samples.to_vec(), at }) {
				Ok(()) => {},
				Err(TrySendError::Full(_)) => {
					core
						.render_dropped
						.store(true, std::sync::atomic::Ordering::Release);
				},
				Err(TrySendError::Disconnected(_)) => {
					if !core.closing.load(std::sync::atomic::Ordering::Acquire) {
						core.report_failure(
							"Native live speaker reference closed unexpectedly".to_owned(),
						);
					}
				},
			}
		}),
	)
}

pub(super) fn open_capture(
	core: Weak<LivePeerCore>,
	sender: Sender<CaptureChunk>,
) -> crate::VoiceResult<CaptureStream> {
	let mut boundary = CaptureBoundary::default();
	CaptureStream::start(processing::SAMPLE_RATE, move |samples, captured_at| {
		let callback_at = Instant::now();
		let Some(core) = core.upgrade() else {
			return;
		};
		if core.closing.load(std::sync::atomic::Ordering::Acquire) {
			return;
		}
		let generation = core
			.microphone_epoch
			.load(std::sync::atomic::Ordering::Acquire);
		if !boundary.accepts(generation, callback_at, captured_at) {
			return;
		}
		let chunk = CaptureChunk { samples: samples.to_vec(), at: captured_at, generation };
		match sender.try_send(chunk) {
			Ok(()) => {},
			Err(TrySendError::Full(_)) => {
				core
					.capture_dropped
					.store(true, std::sync::atomic::Ordering::Release);
			},
			Err(TrySendError::Disconnected(_)) => {
				if !core.closing.load(std::sync::atomic::Ordering::Acquire) {
					core.report_failure("Native live microphone queue closed unexpectedly".to_owned());
				}
			},
		}
	})
}

/// Rejects capture backlog after unmute. The callback that first observes a
/// new microphone epoch may have been scheduled before the unmute, so the
/// next callback's arrival becomes the cutoff, and only audio captured at or
/// after it, in non-decreasing capture order, is admitted.
#[derive(Default)]
struct CaptureBoundary {
	generation:       Option<u64>,
	cutoff:           Option<Instant>,
	previous_capture: Option<Instant>,
}

impl CaptureBoundary {
	fn accepts(&mut self, generation: u64, callback_at: Instant, captured_at: Instant) -> bool {
		if !generation.is_multiple_of(2) || self.generation != Some(generation) {
			self.generation = Some(generation);
			self.cutoff = None;
			self.previous_capture = None;
			return false;
		}
		let accepted = captured_at >= *self.cutoff.get_or_insert(callback_at)
			&& self
				.previous_capture
				.is_none_or(|previous| captured_at >= previous);
		if accepted {
			self.previous_capture = Some(captured_at);
		}
		accepted
	}
}

/// Outgoing RTP timeline, kept in capture time. RTP counts audio samples, not
/// callback wall-clock jitter: a capture gap advances the timestamp by whole
/// 20 ms packets without consuming sequence numbers, so the receiver keeps
/// its fixed-duration source grid and sees no invented packet loss.
#[derive(Default)]
struct SendClock {
	/// Capture-time end of the last packet sent.
	end: Option<Instant>,
}

impl SendClock {
	/// Send one 20 ms packet whose audio starts at `at`, first advancing the
	/// timestamp past every whole packet of capture time since the last one.
	async fn send(
		&mut self,
		track: &TrackLocalStaticSample,
		data: Bytes,
		at: Instant,
		core: &LivePeerCore,
	) -> bool {
		let elapsed = self
			.end
			.map_or(Duration::ZERO, |end| at.saturating_duration_since(end));
		let packet = INPUT_FRAME_DURATION.as_millis();
		let skipped = Duration::from_millis((elapsed.as_millis() / packet * packet) as u64);
		let mut gap = skipped;
		while !gap.is_zero() {
			let advance = gap.min(MAX_TIMESTAMP_ADVANCE);
			// The Opus payloader emits no packet for an empty sample, so only the
			// timestamp moves. `write_sample` truncates seconds to RTP ticks;
			// 1 ns keeps every whole-packet advance exact.
			let sample = Sample { duration: advance + Duration::from_nanos(1), ..Default::default() };
			if !write_sample(track, &sample, core).await {
				return false;
			}
			gap -= advance;
		}
		let sample = Sample { data, duration: INPUT_FRAME_DURATION, ..Default::default() };
		if !write_sample(track, &sample, core).await {
			return false;
		}
		self.end = Some(self.end.unwrap_or(at) + skipped + INPUT_FRAME_DURATION);
		true
	}
}

enum Transmit {
	Sent,
	/// Nothing to send; muted silence is next due at the given instant.
	Idle(Option<Instant>),
	Stopped,
}

struct MediaState {
	processor:      Processor,
	decoder:        Option<Decoder>,
	decoded:        Vec<f32>,
	pending:        VecDeque<EncodedAudio>,
	jitter:         JitterBuffer,
	output_level:   RmsMeter,
	silence_packet: Bytes,
	clock:          SendClock,
	muted:          bool,
	suppressed:     bool,
}

impl MediaState {
	fn new(core: &LivePeerCore) -> Result<Self, String> {
		let suppressed = core
			.speaker_suppressed
			.load(std::sync::atomic::Ordering::Acquire);
		Ok(Self {
			processor: Processor::new()?,
			decoder: if suppressed {
				None
			} else {
				Some(new_decoder()?)
			},
			decoded: vec![0.0; playout::MAX_DECODED_OPUS_SAMPLES],
			pending: VecDeque::with_capacity(MAX_PENDING_CAPTURE_PACKETS),
			jitter: JitterBuffer::default(),
			output_level: RmsMeter::new(OUTPUT_LEVEL_SAMPLES),
			silence_packet: encode_silence()?,
			clock: SendClock::default(),
			muted: core.is_muted(),
			suppressed,
		})
	}

	fn command(
		&mut self,
		command: MediaCommand,
		packet_rx: &Receiver<IncomingPacket>,
		capture_rx: &Receiver<CaptureChunk>,
		core: &LivePeerCore,
	) -> bool {
		match command {
			MediaCommand::Close => return false,
			MediaCommand::Muted(muted) if self.muted != muted => {
				self.muted = muted;
				self.pending.clear();
				while capture_rx.try_recv().is_ok() {}
				if !self.reset_processor(core) {
					return false;
				}
				if muted {
					core.report_input_level(0.0);
				}
			},
			MediaCommand::SpeakerSuppressed(suppressed) if self.suppressed != suppressed => {
				self.suppressed = suppressed;
				self.jitter.clear();
				while packet_rx.try_recv().is_ok() {}
				self.output_level.reset();
				if suppressed {
					self.decoder = None;
					core.report_output_level(0.0);
				} else {
					match new_decoder() {
						Ok(decoder) => self.decoder = Some(decoder),
						Err(error) => {
							core.report_failure(error);
							return false;
						},
					}
				}
			},
			MediaCommand::Muted(_) | MediaCommand::SpeakerSuppressed(_) => {},
		}
		true
	}

	/// Feed every queued speaker reference to echo cancellation, oldest
	/// first, so capture is never processed ahead of the output that produced
	/// its echo. The speaker level follows these frames: what actually played.
	fn render_references(
		&mut self,
		mut first: Option<ReferenceFrame>,
		reference_rx: &Receiver<ReferenceFrame>,
		core: &LivePeerCore,
	) -> bool {
		if core
			.render_dropped
			.swap(false, std::sync::atomic::Ordering::AcqRel)
		{
			// A full queue lost output continuity: discard the backlog that
			// preceded the gap and restart reference history.
			first = None;
			self.processor.reset_render();
			for _ in 0..REFERENCE_QUEUE_CAPACITY {
				if reference_rx.try_recv().is_err() {
					break;
				}
			}
		}
		let mut stale = false;
		// Bounded so a producer that keeps writing cannot starve capture.
		for frame in first
			.into_iter()
			.chain(reference_rx.try_iter())
			.take(REFERENCE_QUEUE_CAPACITY + 1)
		{
			let now = Instant::now();
			if now.saturating_duration_since(frame.at) > processing::MAX_PROCESSING_DELAY {
				if !stale {
					self.processor.reset_render();
					stale = true;
				}
				continue;
			}
			stale = false;
			if let Err(error) = self.processor.render(&frame.samples, frame.at, now) {
				core.report_failure(error.to_owned());
				return false;
			}
			self
				.output_level
				.push(&frame.samples, |level| core.report_output_level(level));
		}
		true
	}

	fn capture(
		&mut self,
		chunk: CaptureChunk,
		capture_rx: &Receiver<CaptureChunk>,
		core: &LivePeerCore,
	) -> bool {
		if core
			.capture_dropped
			.swap(false, std::sync::atomic::Ordering::AcqRel)
		{
			self.pending.clear();
			if !self.reset_processor(core) {
				return false;
			}
			while capture_rx.try_recv().is_ok() {}
			return true;
		}
		let generation = core
			.microphone_epoch
			.load(std::sync::atomic::Ordering::Acquire);
		if self.muted || !generation.is_multiple_of(2) || chunk.generation != generation {
			return true;
		}

		let result = self
			.processor
			.capture(&chunk.samples, chunk.at, Instant::now(), |level| {
				core.report_input_level(level);
			});
		let packets = match result {
			Ok(packets) => packets,
			Err(processing::PROCESSING_LATE) => {
				self.pending.clear();
				return self.reset_processor(core);
			},
			Err(error) => {
				core.report_failure(error.to_owned());
				return false;
			},
		};
		for packet in packets {
			if core.is_muted() {
				self.pending.clear();
				break;
			}
			if self.pending.len() >= MAX_PENDING_CAPTURE_PACKETS {
				self.pending.clear();
				return self.reset_processor(core);
			}
			self.pending.push_back(packet);
		}
		true
	}

	fn play(&mut self, event: JitterEvent, playback: &PlaybackWriter, core: &LivePeerCore) -> bool {
		if self.suppressed
			|| core
				.speaker_suppressed
				.load(std::sync::atomic::Ordering::Acquire)
		{
			return true;
		}
		let Some(decoder) = self.decoder.as_mut() else {
			return true;
		};
		let packet = match event {
			JitterEvent::Packet(packet) => Some(packet),
			JitterEvent::Lost => None,
		};
		let payload = packet.as_ref().map(|packet| packet.payload.as_ref());
		let decoded_len = match playout::decode_opus(decoder, payload, &mut self.decoded) {
			Ok(len) => len,
			Err(error) => {
				core.report_failure(format!("Failed to decode live speaker audio: {error}"));
				return false;
			},
		};
		if self.decoded[..decoded_len]
			.iter()
			.any(|sample| !sample.is_finite())
		{
			core.report_failure("Invalid decoded live speaker audio".to_owned());
			return false;
		}
		if let Err(error) = playback.write(&self.decoded[..decoded_len]) {
			core.report_failure(format!("Live speaker playback failed: {error}"));
			return false;
		}
		true
	}

	/// Send the oldest encoded frame or, while muted, silence once the last
	/// packet's audio has elapsed. Frames go out as soon as capture produces
	/// them, one per call, so queued commands keep priority between packets
	/// while a backlog drains.
	async fn transmit(
		&mut self,
		track: &TrackLocalStaticSample,
		core: &LivePeerCore,
		now: Instant,
	) -> Transmit {
		let (data, at) = if core.is_muted() {
			self.pending.clear();
			if let Some(end) = self.clock.end.filter(|&end| now < end) {
				return Transmit::Idle(Some(end));
			}
			(self.silence_packet.clone(), now)
		} else {
			let Some(frame) = self.pending.pop_front() else {
				return Transmit::Idle(None);
			};
			if now.saturating_duration_since(frame.at) > processing::MAX_PROCESSING_DELAY {
				self.pending.clear();
				return if self.reset_processor(core) {
					Transmit::Idle(None)
				} else {
					Transmit::Stopped
				};
			}
			(Bytes::from(frame.data), frame.at)
		};
		if self.clock.send(track, data, at, core).await {
			Transmit::Sent
		} else {
			Transmit::Stopped
		}
	}

	fn reset_processor(&mut self, core: &LivePeerCore) -> bool {
		if let Err(error) = self.processor.reset() {
			core.report_failure(error);
			return false;
		}
		true
	}
}

pub(super) async fn run_media(
	track: Arc<TrackLocalStaticSample>,
	capture_rx: Receiver<CaptureChunk>,
	reference_rx: Receiver<ReferenceFrame>,
	packet_rx: Receiver<IncomingPacket>,
	command_rx: Receiver<MediaCommand>,
	playback: PlaybackWriter,
	core: Weak<LivePeerCore>,
) {
	let Some(core_ref) = core.upgrade() else {
		return;
	};
	let mut state = match MediaState::new(&core_ref) {
		Ok(state) => state,
		Err(error) => {
			core_ref.report_failure(error);
			return;
		},
	};
	drop(core_ref);
	let mut command_open = true;
	let mut packet_open = true;
	let mut reference_open = true;

	loop {
		let Some(core_ref) = core.upgrade() else {
			return;
		};
		if core_ref.closing.load(std::sync::atomic::Ordering::Acquire) {
			return;
		}
		if command_open {
			match command_rx.try_recv() {
				Ok(command) => {
					if !state.command(command, &packet_rx, &capture_rx, &core_ref) {
						return;
					}
					continue;
				},
				Err(flume::TryRecvError::Disconnected) => command_open = false,
				Err(flume::TryRecvError::Empty) => {},
			}
		}
		if let Some(event) = state.jitter.pop_ready(Instant::now()) {
			if !state.play(event, &playback, &core_ref) {
				return;
			}
			continue;
		}
		let silence_due = match state.transmit(&track, &core_ref, Instant::now()).await {
			Transmit::Sent => continue,
			Transmit::Idle(due) => due,
			Transmit::Stopped => return,
		};
		let deadline = state.jitter.next_deadline();
		drop(core_ref);

		tokio::select! {
			biased;
			command = command_rx.recv_async(), if command_open => {
				match command {
					Ok(command) => {
					let Some(core_ref) = core.upgrade() else { return; };
					if !state.command(command, &packet_rx, &capture_rx, &core_ref) { return; }
					},
					Err(_) => command_open = false,
				}
			},
			packet = packet_rx.recv_async(), if packet_open => {
				match packet {
					Ok(packet) => {
					let Some(core_ref) = core.upgrade() else { return; };
					if !core_ref.speaker_suppressed.load(std::sync::atomic::Ordering::Acquire) {
						state.jitter.push(packet);
					}
				},
					Err(_) => packet_open = false,
				}
			},
			frame = reference_rx.recv_async(), if reference_open => {
				match frame {
					Ok(frame) => {
					let Some(core_ref) = core.upgrade() else { return; };
					if !state.render_references(Some(frame), &reference_rx, &core_ref) { return; }
				},
					Err(_) => reference_open = false,
				}
			},
			chunk = capture_rx.recv_async() => {
				let Ok(chunk) = chunk else {
					if let Some(core_ref) = core.upgrade()
						&& !core_ref.closing.load(std::sync::atomic::Ordering::Acquire)
					{
						core_ref.report_failure(
							"Native live microphone capture stopped unexpectedly".to_owned(),
						);
					}
					return;
				};
				let Some(core_ref) = core.upgrade() else { return; };
				if !state.render_references(None, &reference_rx, &core_ref) { return; }
				if !state.capture(chunk, &capture_rx, &core_ref) { return; }
			},
			() = wait_until(silence_due) => {},
			() = wait_until(deadline) => {},
		}
	}
}

async fn wait_until(deadline: Option<Instant>) {
	match deadline {
		Some(deadline) => {
			tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
		},
		None => std::future::pending::<()>().await,
	}
}

pub(super) async fn receive_output_audio(
	track: Arc<TrackRemote>,
	incoming_tx: Sender<IncomingPacket>,
	budget: IngressBudget,
	core: Weak<LivePeerCore>,
) {
	if !track
		.codec()
		.capability
		.mime_type
		.eq_ignore_ascii_case(MIME_TYPE_OPUS)
	{
		if let Some(core) = core.upgrade() {
			core.report_failure(format!(
				"Codex live negotiated unsupported audio codec {}",
				track.codec().capability.mime_type
			));
		}
		return;
	}
	let mut source = None;
	loop {
		let packet = match track.read_rtp().await {
			Ok((packet, _attributes)) => packet,
			Err(error) => {
				if let Some(core) = core.upgrade()
					&& !core.closing.load(std::sync::atomic::Ordering::Acquire)
				{
					core.report_failure(format!("Live remote audio track failed: {error}"));
				}
				return;
			},
		};
		let Some(core) = core.upgrade() else {
			return;
		};
		if core.closing.load(std::sync::atomic::Ordering::Acquire) {
			return;
		}
		if packet.header.payload_type != OPUS_PAYLOAD_TYPE
			|| source.is_some_and(|ssrc| ssrc != packet.header.ssrc)
		{
			core.report_failure("Live remote audio stream changed unexpectedly".to_owned());
			return;
		}
		source = Some(packet.header.ssrc);
		if core
			.speaker_suppressed
			.load(std::sync::atomic::Ordering::Acquire)
		{
			continue;
		}
		let size = packet.marshal_size();
		let permit = match budget.try_acquire(size) {
			Ok(Some(permit)) => permit,
			Ok(None) => continue,
			Err(error) => {
				core.report_failure(error.to_owned());
				return;
			},
		};
		let incoming = IncomingPacket {
			sequence:   packet.header.sequence_number,
			payload:    packet.payload,
			arrived_at: Instant::now(),
			_permit:    permit,
		};
		let _ = incoming_tx.try_send(incoming);
	}
}

fn new_decoder() -> Result<Decoder, String> {
	Decoder::new(processing::SAMPLE_RATE, Channels::Mono)
		.map_err(|error| format!("Failed to initialize the live Opus decoder: {error}"))
}

fn encode_silence() -> Result<Bytes, String> {
	let mut encoder = Encoder::new(processing::SAMPLE_RATE, Channels::Mono, Application::Voip)
		.map_err(|error| format!("Failed to initialize the live silence encoder: {error}"))?;
	let mut encoded = vec![0; processing::MAX_ENCODED_OPUS_BYTES];
	let length = encoder
		.encode_float(&[0.0; processing::OPUS_FRAME_SAMPLES], &mut encoded)
		.map_err(|error| format!("Failed to encode live silence: {error}"))?;
	encoded.truncate(length);
	Ok(Bytes::from(encoded))
}

async fn write_sample(
	track: &TrackLocalStaticSample,
	sample: &Sample,
	core: &LivePeerCore,
) -> bool {
	if let Err(error) = track.write_sample(sample).await {
		core.report_failure(format!("Failed to send live microphone audio: {error}"));
		return false;
	}
	true
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::Ordering;

	use webrtc::{
		api::{APIBuilder, media_engine::MediaEngine, setting_engine::SettingEngine},
		ice::{mdns::MulticastDnsMode, network_type::NetworkType},
		peer_connection::configuration::RTCConfiguration,
		rtp_transceiver::rtp_codec::{RTCRtpCodecParameters, RTPCodecType},
		track::track_local::TrackLocal,
	};

	use super::*;
	use crate::live::{LiveCallbacks, opus_capability};

	fn quiet_core() -> LivePeerCore {
		LivePeerCore::new(LiveCallbacks {
			event:   Box::new(|_| {}),
			levels:  Box::new(|_, _| {}),
			failure: Box::new(|message| panic!("unexpected live failure: {message}")),
		})
	}

	fn audio_track() -> Arc<TrackLocalStaticSample> {
		Arc::new(TrackLocalStaticSample::new(
			opus_capability(),
			"audio".to_owned(),
			"test".to_owned(),
		))
	}

	#[test]
	fn capture_boundary_admits_only_audio_captured_after_unmute_settles() {
		let start = Instant::now();
		let ms = |millis: u64| start + Duration::from_millis(millis);
		let mut boundary = CaptureBoundary::default();
		// The first callback of an epoch may have been scheduled before it.
		assert!(!boundary.accepts(2, ms(20), ms(0)));
		// The next callback sets the cutoff; its own audio predates it.
		assert!(!boundary.accepts(2, ms(40), ms(20)));
		assert!(boundary.accepts(2, ms(60), ms(40)));
		assert!(boundary.accepts(2, ms(80), ms(60)));
		// Capture time must not run backwards, even after the cutoff.
		assert!(!boundary.accepts(2, ms(100), ms(50)));
		assert!(boundary.accepts(2, ms(120), ms(100)));
		// Muting, or a full mute/unmute cycle between two callbacks, restarts
		// admission.
		assert!(!boundary.accepts(3, ms(140), ms(120)));
		assert!(!boundary.accepts(4, ms(160), ms(140)));
		assert!(!boundary.accepts(4, ms(180), ms(160)));
		assert!(boundary.accepts(4, ms(200), ms(180)));
	}

	#[test]
	fn speaker_level_follows_played_references_and_skips_dropped_or_stale_ones() {
		let (level_tx, level_rx) = flume::unbounded();
		let core = LivePeerCore::new(LiveCallbacks {
			event:   Box::new(|_| {}),
			levels:  Box::new(move |_input, output| {
				level_tx.send(output).expect("level receiver is live");
			}),
			failure: Box::new(|message| panic!("unexpected live failure: {message}")),
		});
		let mut state = MediaState::new(&core).unwrap();
		let (reference_tx, reference_rx) = reference_channel();
		let frame = |level: f32, at: Instant| ReferenceFrame {
			samples: vec![level; OUTPUT_LEVEL_SAMPLES],
			at,
		};
		let now = Instant::now();

		// A full queue lost continuity, so its backlog is discarded unplayed.
		reference_tx.send(frame(0.5, now)).unwrap();
		core.render_dropped.store(true, Ordering::Release);
		assert!(state.render_references(Some(frame(0.5, now)), &reference_rx, &core));
		assert!(!core.render_dropped.load(Ordering::Acquire));
		assert!(reference_rx.is_empty());
		assert_eq!(level_rx.try_iter().count(), 0);

		// Output older than the processing deadline cannot align with capture.
		let stale = now
			.checked_sub(processing::MAX_PROCESSING_DELAY * 2)
			.unwrap();
		reference_tx.send(frame(0.5, stale)).unwrap();
		assert!(state.render_references(None, &reference_rx, &core));
		assert_eq!(level_rx.try_iter().count(), 0);

		reference_tx
			.send(frame(0.25, now + Duration::from_millis(40)))
			.unwrap();
		assert!(state.render_references(None, &reference_rx, &core));
		assert_eq!(level_rx.try_iter().collect::<Vec<_>>(), [0.25]);
	}

	#[tokio::test]
	async fn queued_frames_go_out_unpaced_and_muted_silence_follows_the_packet_clock() {
		let core = quiet_core();
		let mut state = MediaState::new(&core).unwrap();
		let track = audio_track();
		let start = Instant::now();
		let ms = |millis: u64| start + Duration::from_millis(millis);

		// A backlog left by a stalled worker drains at once, continuing the
		// timeline without skipped packets.
		for index in 0..5 {
			state
				.pending
				.push_back(EncodedAudio { data: vec![index], at: ms(u64::from(index) * 20) });
		}
		for _ in 0..5 {
			assert!(matches!(state.transmit(&track, &core, ms(100)).await, Transmit::Sent));
		}
		assert!(matches!(state.transmit(&track, &core, ms(100)).await, Transmit::Idle(None)));
		assert_eq!(state.clock.end, Some(ms(100)));

		// Muted silence waits for the last packet's audio to elapse, and a late
		// wake-up skips the whole packets it missed.
		core.set_muted(true).unwrap();
		assert!(matches!(state.transmit(&track, &core, ms(100)).await, Transmit::Sent));
		assert!(
			matches!(state.transmit(&track, &core, ms(119)).await, Transmit::Idle(Some(due)) if due == ms(120))
		);
		assert!(matches!(state.transmit(&track, &core, ms(190)).await, Transmit::Sent));
		assert_eq!(state.clock.end, Some(ms(200)));
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn capture_gaps_advance_rtp_time_by_whole_packets_without_sequence_gaps() {
		let core = quiet_core();
		let mut media = MediaEngine::default();
		media
			.register_codec(
				RTCRtpCodecParameters {
					capability: opus_capability(),
					payload_type: OPUS_PAYLOAD_TYPE,
					..Default::default()
				},
				RTPCodecType::Audio,
			)
			.unwrap();
		// Loopback only: no LAN interfaces or multicast sockets.
		let mut settings = SettingEngine::default();
		settings.set_include_loopback_candidate(true);
		settings.set_ip_filter(Box::new(|ip| ip.is_loopback()));
		settings.set_network_types(vec![NetworkType::Udp4]);
		settings.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
		let api = APIBuilder::new()
			.with_media_engine(media)
			.with_setting_engine(settings)
			.build();
		let sender = api
			.new_peer_connection(RTCConfiguration::default())
			.await
			.unwrap();
		let receiver = api
			.new_peer_connection(RTCConfiguration::default())
			.await
			.unwrap();
		let track = audio_track();
		sender
			.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
			.await
			.unwrap();
		let (remote_tx, remote_rx) = flume::bounded(1);
		receiver.on_track(Box::new(move |remote, _receiver, _transceiver| {
			let _ = remote_tx.try_send(remote);
			Box::pin(async {})
		}));
		let offer = sender.create_offer(None).await.unwrap();
		let mut gathered = sender.gathering_complete_promise().await;
		sender.set_local_description(offer).await.unwrap();
		let _ = gathered.recv().await;
		receiver
			.set_remote_description(sender.local_description().await.unwrap())
			.await
			.unwrap();
		let answer = receiver.create_answer(None).await.unwrap();
		let mut gathered = receiver.gathering_complete_promise().await;
		receiver.set_local_description(answer).await.unwrap();
		let _ = gathered.recv().await;
		sender
			.set_remote_description(receiver.local_description().await.unwrap())
			.await
			.unwrap();

		// The track drops writes until DTLS binds it; prime until media flows.
		let mut clock = SendClock::default();
		let remote = tokio::time::timeout(Duration::from_secs(10), async {
			loop {
				assert!(
					clock
						.send(&track, Bytes::from_static(&[0]), Instant::now(), &core)
						.await
				);
				if let Ok(remote) = remote_rx.try_recv() {
					break remote;
				}
				tokio::time::sleep(INPUT_FRAME_DURATION).await;
			}
		})
		.await
		.expect("loopback media flows");

		// Callback jitter inside a packet, a 65 ms capture stall, then audio
		// stamped just before the previous packet ended.
		let start = clock.end.unwrap();
		for (marker, millis) in [(1, 0), (2, 21), (3, 105), (4, 118)] {
			let at = start + Duration::from_millis(millis);
			assert!(
				clock
					.send(&track, Bytes::from(vec![marker]), at, &core)
					.await
			);
		}
		let mut received = Vec::new();
		while received.len() < 4 {
			let (packet, _) = tokio::time::timeout(Duration::from_secs(5), remote.read_rtp())
				.await
				.expect("marked packets arrive")
				.unwrap();
			if packet.payload[..] != [0] {
				received.push((
					packet.payload[0],
					packet.header.sequence_number,
					packet.header.timestamp,
				));
			}
		}
		let (_, first_sequence, first_timestamp) = received[0];
		let relative: Vec<_> = received
			.iter()
			.map(|&(marker, sequence, timestamp)| {
				(marker, sequence.wrapping_sub(first_sequence), timestamp.wrapping_sub(first_timestamp))
			})
			.collect();
		assert_eq!(relative, [(1, 0, 0), (2, 1, 960), (3, 2, 960 * 5), (4, 3, 960 * 6)]);
		sender.close().await.unwrap();
		receiver.close().await.unwrap();
	}
}
