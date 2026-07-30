//! Bounded adaptive playout for the remote Opus track.
//!
//! RTP arrives bursty and occasionally out of order. Writing each packet to the
//! speaker the moment it is read splices silence between bursts and replays
//! stale audio after a pause. This buffer reorders by extended RTP sequence,
//! decodes exactly once per packet in playout order, and hands the speaker a
//! continuous stream of 10 ms blocks.
//!
//! Loss concealment uses the installed `opus` decoder directly so in-band FEC
//! stays available: the packet after a single-frame gap carries a redundant
//! copy of the lost frame, and older loss falls back to the decoder's own PLC.

use std::collections::{BTreeMap, VecDeque};

use bytes::Bytes;
use opus::Decoder;

/// 10 ms of 48 kHz mono PCM handed to the speaker per playout tick.
pub const PLAYOUT_BLOCK_SAMPLES: usize = 480;
/// 20 ms of 48 kHz mono PCM carried by one Opus packet.
const PACKET_SAMPLES: usize = 960;
/// Largest frame the decoder may emit (120 ms at 48 kHz).
const MAX_DECODED_SAMPLES: usize = 5_760;
/// Playout delay used until arrival jitter has been measured.
const START_DELAY_MS: u32 = 60;
/// Lower bound of the adaptive playout delay.
const MIN_DELAY_MS: u32 = 40;
/// Upper bound of the adaptive playout delay.
const MAX_DELAY_MS: u32 = 120;
/// 250 ms ceiling on buffered remote audio, decoded plus pending.
const MAX_BUFFERED_SAMPLES: usize = 12_000;
/// RTP clock rate of the negotiated Opus stream.
const CLOCK_RATE: f64 = 48_000.0;

/// Counters describing how the remote stream behaved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlayoutStats {
	/// RTP packets accepted into the reorder buffer.
	pub packets:          u64,
	/// Distinct runs of missing sequence numbers observed at playout time.
	pub sequence_gaps:    u64,
	/// Frames synthesized by FEC or PLC instead of decoded from a packet.
	pub concealed_frames: u64,
	/// Samples discarded because a packet missed its deadline or overflowed.
	pub dropped_samples:  u64,
}

/// Whether a playout tick produced decoded audio or filled silence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayoutBlock {
	/// The block carries remote audio.
	Audio,
	/// The buffer is priming or starved; the block is silence.
	Silence,
}

/// RFC 3550 interarrival jitter tracked in RTP timestamp units.
#[derive(Default)]
struct Jitter {
	estimate: f64,
	previous: Option<(u32, f64)>,
	deltas:   u32,
}

impl Jitter {
	fn observe(&mut self, rtp_timestamp: u32, arrival_seconds: f64) {
		let arrival_units = arrival_seconds * CLOCK_RATE;
		if let Some((previous_rtp, previous_arrival)) = self.previous {
			let transit = (arrival_units - previous_arrival)
				- f64::from(rtp_timestamp.wrapping_sub(previous_rtp) as i32);
			self.estimate += (transit.abs() - self.estimate) / 16.0;
			self.deltas += 1;
		}
		self.previous = Some((rtp_timestamp, arrival_units));
	}

	fn milliseconds(&self) -> f64 {
		self.estimate * 1_000.0 / CLOCK_RATE
	}

	/// The `/16` EWMA starts at zero, so a handful of arrivals must accumulate
	/// before it stops reporting an artificially jitter-free stream. Until then
	/// playout keeps its 60 ms start delay.
	const fn measured(&self) -> bool {
		self.deltas >= 8
	}
}

/// Reordering, adaptive-delay playout buffer for one remote Opus track.
pub struct Playout {
	decoder:  Decoder,
	pending:  BTreeMap<u64, Bytes>,
	ready:    VecDeque<f32>,
	scratch:  Box<[f32]>,
	next_seq: Option<u64>,
	last_seq: Option<u16>,
	cycles:   u64,
	jitter:   Jitter,
	started:  bool,
	in_gap:   bool,
	stats:    PlayoutStats,
}

impl Playout {
	/// Create a playout buffer around a fresh mono 48 kHz Opus decoder.
	pub fn new(decoder: Decoder) -> Self {
		Self {
			decoder,
			pending: BTreeMap::new(),
			ready: VecDeque::new(),
			scratch: vec![0.0; MAX_DECODED_SAMPLES].into_boxed_slice(),
			next_seq: None,
			last_seq: None,
			cycles: 0,
			jitter: Jitter::default(),
			started: false,
			in_gap: false,
			stats: PlayoutStats::default(),
		}
	}

	/// Observed stream health.
	pub const fn stats(&self) -> PlayoutStats {
		self.stats
	}

	/// Current adaptive playout delay in milliseconds.
	pub fn target_delay_ms(&self) -> u32 {
		if !self.jitter.measured() {
			return START_DELAY_MS;
		}
		let adaptive = 3.0f64.mul_add(self.jitter.milliseconds(), f64::from(MIN_DELAY_MS));
		(adaptive.round() as u32).clamp(MIN_DELAY_MS, MAX_DELAY_MS)
	}

	/// Accept one RTP packet, discarding audio that already missed its
	/// deadline.
	pub fn accept(
		&mut self,
		sequence: u16,
		rtp_timestamp: u32,
		payload: Bytes,
		arrival_seconds: f64,
	) {
		if payload.is_empty() {
			return;
		}
		let extended = self.extend(sequence);
		if self.next_seq.is_some_and(|next| extended < next) {
			self.stats.dropped_samples += PACKET_SAMPLES as u64;
			return;
		}
		self.jitter.observe(rtp_timestamp, arrival_seconds);
		if self.pending.insert(extended, payload).is_none() {
			self.stats.packets += 1;
		}
		while self.buffered_samples() > MAX_BUFFERED_SAMPLES {
			let Some(oldest) = self.pending.keys().next().copied() else {
				break;
			};
			self.pending.remove(&oldest);
			self.stats.dropped_samples += PACKET_SAMPLES as u64;
			if self.next_seq.is_some_and(|next| next <= oldest) {
				self.next_seq = Some(oldest + 1);
			}
		}
	}

	/// Emit the next 10 ms of playout audio, priming or concealing as needed.
	pub fn pull(&mut self, block: &mut [f32; PLAYOUT_BLOCK_SAMPLES]) -> PlayoutBlock {
		block.fill(0.0);
		if !self.started {
			let target = self.target_delay_ms() as usize * (CLOCK_RATE as usize) / 1_000;
			if self.buffered_samples() < target {
				return PlayoutBlock::Silence;
			}
			self.started = true;
		}
		while self.ready.len() < PLAYOUT_BLOCK_SAMPLES && self.decode_next() {}
		if self.ready.len() < PLAYOUT_BLOCK_SAMPLES {
			self.started = false;
			return PlayoutBlock::Silence;
		}
		for slot in block.iter_mut() {
			*slot = self.ready.pop_front().unwrap_or(0.0);
		}
		PlayoutBlock::Audio
	}

	/// Decoded plus pending samples currently held.
	fn buffered_samples(&self) -> usize {
		self.ready.len() + self.pending.len() * PACKET_SAMPLES
	}

	/// Decode one frame in playout order; returns false when nothing is
	/// available.
	fn decode_next(&mut self) -> bool {
		let Some(&first) = self.pending.keys().next() else {
			return false;
		};
		let next = *self.next_seq.get_or_insert(first);
		if let Some(payload) = self.pending.remove(&next) {
			self.next_seq = Some(next + 1);
			self.in_gap = false;
			return self.decode(Some(&payload), false);
		}
		// The expected frame is missing while later audio is already buffered,
		// so its deadline has passed and the gap must be concealed now.
		if !self.in_gap {
			self.in_gap = true;
			self.stats.sequence_gaps += 1;
		}
		self.stats.concealed_frames += 1;
		self.next_seq = Some(next + 1);
		if first == next + 1
			&& let Some(payload) = self.pending.get(&first).cloned()
			&& self.decode(Some(&payload), true)
		{
			// The immediately following packet carried in-band FEC for this frame.
			return true;
		}
		self.decode(None, false)
	}

	fn decode(&mut self, payload: Option<&[u8]>, fec: bool) -> bool {
		let limit = if fec {
			PACKET_SAMPLES
		} else {
			MAX_DECODED_SAMPLES
		};
		let decoded = match payload {
			Some(payload) => self
				.decoder
				.decode_float(payload, &mut self.scratch[..limit], fec),
			None => self
				.decoder
				.decode_float(&[], &mut self.scratch[..PACKET_SAMPLES], false),
		};
		let Ok(samples) = decoded else {
			return false;
		};
		if samples == 0 {
			return false;
		}
		self.ready.extend(&self.scratch[..samples]);
		true
	}

	/// Expand a 16-bit RTP sequence number into a monotonic playout order.
	fn extend(&mut self, sequence: u16) -> u64 {
		let Some(last) = self.last_seq else {
			self.last_seq = Some(sequence);
			return u64::from(sequence);
		};
		if sequence.wrapping_sub(last) < 0x8000 {
			if sequence < last {
				self.cycles += 1;
			}
			self.last_seq = Some(sequence);
			return self.cycles * 65_536 + u64::from(sequence);
		}
		let behind = u64::from(last.wrapping_sub(sequence));
		(self.cycles * 65_536 + u64::from(last)).saturating_sub(behind)
	}
}

#[cfg(test)]
mod tests {
	use opus::{Application, Channels, Encoder};

	use super::*;

	fn decoder() -> Decoder {
		Decoder::new(48_000, Channels::Mono).expect("mono 48 kHz decoder")
	}

	/// Encode `count` distinct 20 ms tones so decode order is observable.
	fn packets(count: usize) -> Vec<Bytes> {
		let mut encoder =
			Encoder::new(48_000, Channels::Mono, Application::Voip).expect("mono 48 kHz encoder");
		encoder.set_inband_fec(true).expect("fec is supported");
		encoder
			.set_packet_loss_perc(10)
			.expect("loss percentage is supported");
		let mut encoded = [0u8; 1_275];
		(0..count)
			.map(|index| {
				let frequency = 110.0f32.mul_add(index as f32, 220.0);
				let frame: Vec<f32> = (0..PACKET_SAMPLES)
					.map(|sample| {
						(sample as f32 * frequency * std::f32::consts::TAU / 48_000.0).sin() * 0.4
					})
					.collect();
				let length = encoder
					.encode_float(&frame, &mut encoded)
					.expect("frame encodes");
				Bytes::copy_from_slice(&encoded[..length])
			})
			.collect()
	}

	fn drain(playout: &mut Playout, ticks: usize) -> (usize, usize) {
		let mut block = [0.0; PLAYOUT_BLOCK_SAMPLES];
		let mut audio = 0;
		let mut silence = 0;
		for _ in 0..ticks {
			match playout.pull(&mut block) {
				PlayoutBlock::Audio => audio += 1,
				PlayoutBlock::Silence => silence += 1,
			}
		}
		(audio, silence)
	}

	#[test]
	fn bursty_arrival_plays_out_continuously_without_silence_splices() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(12);
		// Two bursts of six packets, the pattern that spliced silence when each
		// packet was written to the speaker on arrival.
		for (index, payload) in payloads.iter().enumerate().take(6) {
			playout.accept(index as u16, index as u32 * 960, payload.clone(), index as f64 * 0.02);
		}

		let (primed, _) = drain(&mut playout, 6);
		assert_eq!(primed, 6, "a primed buffer must render every tick");

		for (index, payload) in payloads.iter().enumerate().skip(6) {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payload.clone(),
				(index as f64).mul_add(0.001, 0.2),
			);
		}
		let (audio, silence) = drain(&mut playout, 6);

		assert_eq!(audio, 6);
		assert_eq!(silence, 0);
		assert_eq!(playout.stats().concealed_frames, 0);
	}

	#[test]
	fn reordered_packets_are_played_in_sequence_order() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(4);
		for index in [1usize, 0, 3, 2] {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payloads[index].clone(),
				index as f64 * 0.02,
			);
		}

		let (audio, silence) = drain(&mut playout, 8);

		assert_eq!(audio, 8);
		assert_eq!(silence, 0);
		assert_eq!(playout.stats().concealed_frames, 0);
		assert_eq!(playout.stats().packets, 4);
	}

	#[test]
	fn a_single_lost_frame_is_recovered_from_the_next_packets_fec() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(4);
		for index in [0usize, 2, 3] {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payloads[index].clone(),
				index as f64 * 0.02,
			);
		}

		let (audio, _) = drain(&mut playout, 8);

		assert_eq!(audio, 8, "the concealed frame must still fill its playout slot");
		assert_eq!(playout.stats().concealed_frames, 1);
		assert_eq!(playout.stats().sequence_gaps, 1);
	}

	#[test]
	fn a_multi_frame_gap_conceals_with_plc_and_only_the_last_frame_with_fec() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(6);
		// Sequences 1, 2 and 3 are lost. Only 3 sits immediately before the
		// surviving packet 4, so only it can be recovered from in-band FEC; the
		// older two must fall back to the decoder's own concealment.
		for index in [0usize, 4, 5] {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payloads[index].clone(),
				index as f64 * 0.02,
			);
		}

		let (audio, silence) = drain(&mut playout, 12);

		assert_eq!(audio, 12, "every playout slot must be filled");
		assert_eq!(silence, 0);
		assert_eq!(playout.stats().concealed_frames, 3);
		assert_eq!(
			playout.stats().sequence_gaps,
			1,
			"one contiguous run of loss is one gap, not three"
		);
	}

	#[test]
	fn starvation_reprimes_before_resuming_playout() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(8);
		for (index, payload) in payloads.iter().enumerate().take(3) {
			playout.accept(index as u16, index as u32 * 960, payload.clone(), index as f64 * 0.02);
		}

		// Three packets is exactly the 60 ms start target: six ticks drain them.
		assert_eq!(drain(&mut playout, 6), (6, 0));
		assert_eq!(drain(&mut playout, 1), (0, 1), "an empty buffer must render silence");

		// One fresh packet is below the target, so playout stays primed-off.
		playout.accept(3, 3 * 960, payloads[3].clone(), 0.30);
		assert_eq!(drain(&mut playout, 1), (0, 1));

		for (index, payload) in payloads.iter().enumerate().take(7).skip(4) {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payload.clone(),
				(index as f64).mul_add(0.02, 0.30),
			);
		}
		assert_eq!(drain(&mut playout, 6), (6, 0), "playout resumes once re-primed");
	}

	#[test]
	fn packets_arriving_after_their_deadline_are_discarded() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(4);
		for index in [0usize, 1, 2, 3] {
			playout.accept(
				index as u16,
				index as u32 * 960,
				payloads[index].clone(),
				index as f64 * 0.02,
			);
		}
		drain(&mut playout, 8);

		playout.accept(1, 960, payloads[1].clone(), 0.4);

		assert_eq!(playout.stats().dropped_samples, PACKET_SAMPLES as u64);
	}

	#[test]
	fn buffered_audio_is_capped_at_250ms() {
		let mut playout = Playout::new(decoder());
		let payloads = packets(20);
		for (index, payload) in payloads.iter().enumerate() {
			playout.accept(index as u16, index as u32 * 960, payload.clone(), index as f64 * 0.02);
		}

		assert!(playout.buffered_samples() <= MAX_BUFFERED_SAMPLES);
		assert!(playout.stats().dropped_samples > 0);
	}

	#[test]
	fn playout_delay_starts_at_60ms_and_adapts_within_40_to_120ms() {
		let mut playout = Playout::new(decoder());
		assert_eq!(playout.target_delay_ms(), START_DELAY_MS);

		let payloads = packets(8);
		for (index, payload) in payloads.iter().enumerate() {
			// Alternating early/late arrivals produce measurable jitter.
			let arrival = (index as f64).mul_add(0.02, if index % 2 == 0 { 0.0 } else { 0.03 });
			playout.accept(index as u16, index as u32 * 960, payload.clone(), arrival);
		}

		let delay = playout.target_delay_ms();
		assert!((MIN_DELAY_MS..=MAX_DELAY_MS).contains(&delay), "delay {delay} out of range");
	}

	#[test]
	fn sequence_numbers_extend_across_a_wrap() {
		let mut playout = Playout::new(decoder());
		assert_eq!(playout.extend(65_534), 65_534);
		assert_eq!(playout.extend(65_535), 65_535);
		assert_eq!(playout.extend(0), 65_536);
		assert_eq!(playout.extend(65_535), 65_535);
		assert_eq!(playout.extend(1), 65_537);
	}
}
