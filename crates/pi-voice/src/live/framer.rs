//! Capture-clocked microphone framing for the native live peer.
//!
//! The microphone device is the only clock: DSP blocks and Opus packets are
//! produced strictly from samples the device delivered. Nothing here ever
//! fabricates an unmuted frame, so a late capture callback delays a packet
//! instead of transmitting silence the user never spoke.
//!
//! [`CaptureQueue`] is the bounded hand-off between the device callback and the
//! encoder task. It is deliberately a fixed-capacity ring rather than a
//! channel: a stalled consumer must drop the oldest audio, never allocate
//! without limit.

use std::collections::VecDeque;

/// 10 ms of 48 kHz mono PCM, the block size the WebRTC APM accepts.
pub const DSP_BLOCK_SAMPLES: usize = 480;
/// 20 ms of 48 kHz mono PCM, one Opus packet.
pub const OPUS_FRAME_SAMPLES: usize = 960;
/// 250 ms ceiling on capture audio that has not been encoded yet.
pub const MAX_UNENCODED_SAMPLES: usize = 12_000;
/// Absolute sample value that counts as speech onset while buffering startup.
pub const STARTUP_ONSET_THRESHOLD: f32 = 0.003;
/// 100 ms of context preserved ahead of the detected onset.
pub const STARTUP_PREROLL_SAMPLES: usize = 4_800;
/// 30 s ceiling on pre-activation capture retention.
pub const STARTUP_MAX_SAMPLES: usize = 1_440_000;

/// Bounded capture ring shared between the device callback and the encoder.
///
/// Live capture is capped at 250 ms so a stalled consumer drops the oldest
/// audio rather than growing without limit. The one-shot startup release is
/// held in its own queue and drained first, because trimming it to 250 ms
/// would discard the very onset it exists to preserve.
#[derive(Default)]
pub struct CaptureQueue {
	raw:        VecDeque<f32>,
	pending:    VecDeque<f32>,
	startup:    StartupBuffer,
	active:     bool,
	dropped:    u64,
	max_queued: usize,
}

impl CaptureQueue {
	/// Accept one capture callback's samples, or the same span of silence when
	/// muted.
	///
	/// Mute is applied here, at capture time, so retained startup audio can
	/// never leak speech the user had muted while it was recorded. Before
	/// activation the sanitized samples are retained for the startup release.
	/// Overflow drops the oldest complete 10 ms blocks so the encoder always
	/// works on the freshest audio.
	pub fn push(&mut self, samples: &[f32], muted: bool) {
		if samples.is_empty() {
			return;
		}
		if !self.active {
			if muted {
				self.startup.push_silence(samples.len());
			} else {
				self.startup.push(samples);
			}
			return;
		}
		if muted {
			self.raw.resize(self.raw.len() + samples.len(), 0.0);
		} else {
			self.raw.extend(samples.iter().copied());
		}
		if self.raw.len() > MAX_UNENCODED_SAMPLES {
			let excess = self.raw.len() - MAX_UNENCODED_SAMPLES;
			let drop_samples = excess
				.div_ceil(DSP_BLOCK_SAMPLES)
				.saturating_mul(DSP_BLOCK_SAMPLES)
				.min(self.raw.len());
			self.raw.drain(..drop_samples);
			self.dropped += drop_samples as u64;
		}
		self.max_queued = self.max_queued.max(self.raw.len());
	}

	/// Release retained startup audio into the encode path exactly once.
	///
	/// Retained audio that never crossed the onset threshold is discarded. The
	/// released slice is already mute-sanitized and bypasses the live cap so
	/// the first word survives.
	pub fn activate(&mut self) {
		if self.active {
			return;
		}
		self.active = true;
		self.pending.extend(self.startup.release());
		self.max_queued = self.max_queued.max(self.pending.len());
	}

	/// Whether transmission has begun.
	pub const fn active(&self) -> bool {
		self.active
	}

	/// Replace queued-but-unsent capture with silence of the same length.
	///
	/// Mute is a privacy control, so nothing already captured may be
	/// transmitted afterwards: neither the up-to-250 ms live ring nor audio
	/// retained for the startup release. Timing is preserved by substituting
	/// silence rather than discarding samples.
	pub fn silence_queued(&mut self) {
		self.raw.iter_mut().for_each(|sample| *sample = 0.0);
		self.pending.iter_mut().for_each(|sample| *sample = 0.0);
		self.startup.silence();
	}

	/// Copy the next complete 10 ms block, startup audio first.
	pub fn next_block(&mut self, block: &mut [f32; DSP_BLOCK_SAMPLES]) -> bool {
		let source = if self.pending.len() >= DSP_BLOCK_SAMPLES {
			&mut self.pending
		} else {
			// A startup remainder shorter than one block joins live capture so
			// no sample is stranded and none is padded with invented silence.
			if !self.pending.is_empty() {
				let remainder = std::mem::take(&mut self.pending);
				for sample in remainder.into_iter().rev() {
					self.raw.push_front(sample);
				}
			}
			&mut self.raw
		};
		if source.len() < DSP_BLOCK_SAMPLES {
			return false;
		}
		for slot in block.iter_mut() {
			*slot = source.pop_front().unwrap_or(0.0);
		}
		true
	}

	/// Samples discarded because unencoded capture exceeded its 250 ms cap.
	pub const fn dropped_samples(&self) -> u64 {
		self.dropped
	}

	/// High-water mark of unencoded capture audio.
	pub const fn max_queued_samples(&self) -> usize {
		self.max_queued
	}
}

/// Assembles processed 10 ms blocks into 20 ms Opus frames.
#[derive(Default)]
pub struct FrameAssembler {
	blocks: Vec<f32>,
}

impl FrameAssembler {
	/// Return one processed 10 ms block to the encode queue.
	pub fn push_processed(&mut self, block: &[f32]) {
		self.blocks.extend_from_slice(block);
	}

	/// Zero the processed half-frame still waiting for its second block, so a
	/// pre-mute block cannot ride out inside a post-mute packet.
	pub fn silence_pending(&mut self) {
		self.blocks.iter_mut().for_each(|sample| *sample = 0.0);
	}

	/// Copy the next complete 20 ms Opus frame, if one is available.
	pub fn next_frame(&mut self, frame: &mut [f32; OPUS_FRAME_SAMPLES]) -> bool {
		if self.blocks.len() < OPUS_FRAME_SAMPLES {
			return false;
		}
		frame.copy_from_slice(&self.blocks[..OPUS_FRAME_SAMPLES]);
		self.blocks.drain(..OPUS_FRAME_SAMPLES);
		true
	}
}

/// Pre-activation capture retention.
///
/// Codex accepts input only once the peer is connected and `session.started`
/// has arrived. Speech before that would otherwise be lost, so it is retained
/// and released once, trimmed to the first onset plus a short pre-roll.
#[derive(Default)]
struct StartupBuffer {
	samples: Vec<f32>,
}

impl StartupBuffer {
	/// Retain capture samples, keeping only the most recent 30 seconds.
	fn push(&mut self, samples: &[f32]) {
		self.samples.extend_from_slice(samples);
		if self.samples.len() > STARTUP_MAX_SAMPLES {
			let excess = self.samples.len() - STARTUP_MAX_SAMPLES;
			self.samples.drain(..excess);
		}
	}

	/// Retain a muted span as silence, preserving capture timing.
	fn push_silence(&mut self, count: usize) {
		self.samples.resize(self.samples.len() + count, 0.0);
		if self.samples.len() > STARTUP_MAX_SAMPLES {
			let excess = self.samples.len() - STARTUP_MAX_SAMPLES;
			self.samples.drain(..excess);
		}
	}

	/// Zero everything retained so far, preserving capture timing.
	fn silence(&mut self) {
		self.samples.iter_mut().for_each(|sample| *sample = 0.0);
	}

	/// Consume the buffer, returning speech from its onset with 100 ms of
	/// pre-roll, or nothing when the audio never crossed the onset threshold.
	fn release(&mut self) -> Vec<f32> {
		let onset = self
			.samples
			.iter()
			.position(|sample| sample.abs() >= STARTUP_ONSET_THRESHOLD);
		let Some(onset) = onset else {
			self.samples = Vec::new();
			return Vec::new();
		};
		let start = onset.saturating_sub(STARTUP_PREROLL_SAMPLES);
		let mut released = std::mem::take(&mut self.samples);
		released.drain(..start);
		released
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn active_queue() -> CaptureQueue {
		let mut queue = CaptureQueue::default();
		queue.activate();
		queue
	}

	#[test]
	fn framing_never_fabricates_an_unmuted_frame() {
		let mut queue = active_queue();
		let mut assembler = FrameAssembler::default();
		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		let mut frame = [0.0; OPUS_FRAME_SAMPLES];

		assert!(!queue.next_block(&mut block));
		assert!(!assembler.next_frame(&mut frame));

		queue.push(&[0.25; DSP_BLOCK_SAMPLES], false);
		assert!(queue.next_block(&mut block));
		assembler.push_processed(&block);
		assert!(
			!assembler.next_frame(&mut frame),
			"a single 10 ms block must not be padded into a 20 ms packet"
		);

		queue.push(&[0.25; DSP_BLOCK_SAMPLES], false);
		assert!(queue.next_block(&mut block));
		assembler.push_processed(&block);
		assert!(assembler.next_frame(&mut frame));
		assert!(
			frame
				.iter()
				.all(|sample| (*sample - 0.25).abs() < f32::EPSILON)
		);
	}

	#[test]
	fn muted_capture_substitutes_silence_at_the_capture_cadence() {
		let mut queue = active_queue();
		let mut block = [1.0; DSP_BLOCK_SAMPLES];

		queue.push(&[0.9; DSP_BLOCK_SAMPLES], true);

		assert!(queue.next_block(&mut block));
		assert_eq!(block, [0.0; DSP_BLOCK_SAMPLES]);
		assert!(!queue.next_block(&mut block));
	}

	#[test]
	fn unencoded_capture_is_capped_at_250ms_and_drops_whole_blocks() {
		let mut queue = active_queue();

		queue.push(&vec![0.5; MAX_UNENCODED_SAMPLES], false);
		assert_eq!(queue.dropped_samples(), 0);
		assert_eq!(queue.max_queued_samples(), MAX_UNENCODED_SAMPLES);
		queue.push(&vec![0.75; DSP_BLOCK_SAMPLES], false);

		assert_eq!(queue.dropped_samples(), DSP_BLOCK_SAMPLES as u64);
		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		assert!(queue.next_block(&mut block));
		assert!(
			block
				.iter()
				.all(|sample| (*sample - 0.5).abs() < f32::EPSILON)
		);
	}

	#[test]
	fn capture_before_activation_is_retained_not_transmitted() {
		let mut queue = CaptureQueue::default();
		let mut block = [0.0; DSP_BLOCK_SAMPLES];

		queue.push(&[0.5; DSP_BLOCK_SAMPLES * 2], false);
		assert!(!queue.active());
		assert!(!queue.next_block(&mut block));

		queue.activate();

		assert!(queue.active());
		assert!(queue.next_block(&mut block));
	}

	#[test]
	fn startup_release_trims_to_onset_with_preroll() {
		let mut queue = CaptureQueue::default();
		queue.push(&vec![0.0; STARTUP_PREROLL_SAMPLES * 3], false);
		queue.push(&[0.5; 100], false);

		queue.activate();

		let mut blocks = 0;
		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		while queue.next_block(&mut block) {
			blocks += 1;
		}
		assert_eq!(blocks, (STARTUP_PREROLL_SAMPLES + 100) / DSP_BLOCK_SAMPLES);
	}

	#[test]
	fn startup_release_discards_audio_without_any_onset() {
		let mut queue = CaptureQueue::default();
		queue.push(&vec![STARTUP_ONSET_THRESHOLD / 2.0; 10_000], false);

		queue.activate();

		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		assert!(!queue.next_block(&mut block));
	}

	#[test]
	fn startup_retention_is_capped_at_thirty_seconds() {
		let mut buffer = StartupBuffer::default();
		buffer.push(&vec![0.0; STARTUP_MAX_SAMPLES]);
		buffer.push(&[0.5; 480]);

		let released = buffer.release();

		assert_eq!(released.len(), STARTUP_PREROLL_SAMPLES + 480);
	}

	#[test]
	fn activation_happens_once_and_never_replays_startup_audio() {
		let mut queue = CaptureQueue::default();
		queue.push(&[0.5; DSP_BLOCK_SAMPLES], false);
		queue.activate();
		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		assert!(queue.next_block(&mut block));

		queue.activate();

		assert!(!queue.next_block(&mut block));
	}

	#[test]
	fn startup_audio_captured_while_muted_never_becomes_speech() {
		let mut queue = CaptureQueue::default();
		queue.push(&[0.9; DSP_BLOCK_SAMPLES * 2], true);

		queue.activate();

		let mut block = [1.0; DSP_BLOCK_SAMPLES];
		assert!(
			!queue.next_block(&mut block),
			"muted startup audio has no onset and must be discarded"
		);
	}

	#[test]
	fn released_startup_audio_bypasses_the_live_capture_cap() {
		let mut queue = CaptureQueue::default();
		let retained = MAX_UNENCODED_SAMPLES * 3;
		queue.push(&vec![0.5; retained], false);

		queue.activate();

		let mut blocks = 0;
		let mut block = [0.0; DSP_BLOCK_SAMPLES];
		while queue.next_block(&mut block) {
			blocks += 1;
		}
		assert_eq!(blocks, retained / DSP_BLOCK_SAMPLES);
		assert_eq!(queue.dropped_samples(), 0);
	}
}

#[cfg(test)]
mod mute_tests {
	use super::*;

	#[test]
	fn muting_silences_speech_already_queued_but_not_yet_sent() {
		let mut queue = CaptureQueue::default();
		queue.activate();
		queue.push(&[0.9; DSP_BLOCK_SAMPLES * 2], false);

		queue.silence_queued();

		let mut block = [1.0; DSP_BLOCK_SAMPLES];
		while queue.next_block(&mut block) {
			assert_eq!(block, [0.0; DSP_BLOCK_SAMPLES], "queued speech must not survive mute");
		}
	}

	#[test]
	fn muting_silences_a_half_assembled_packet() {
		let mut assembler = FrameAssembler::default();
		assembler.push_processed(&[0.9; DSP_BLOCK_SAMPLES]);

		assembler.silence_pending();
		assembler.push_processed(&[0.0; DSP_BLOCK_SAMPLES]);

		let mut frame = [1.0; OPUS_FRAME_SAMPLES];
		assert!(assembler.next_frame(&mut frame));
		assert_eq!(frame, [0.0; OPUS_FRAME_SAMPLES], "the pre-mute block must not ride out");
	}

	#[test]
	fn muting_before_activation_discards_retained_startup_speech() {
		let mut queue = CaptureQueue::default();
		queue.push(&[0.9; DSP_BLOCK_SAMPLES * 2], false);

		queue.silence_queued();
		queue.activate();

		let mut block = [1.0; DSP_BLOCK_SAMPLES];
		assert!(
			!queue.next_block(&mut block),
			"silenced startup audio has no onset and must be discarded"
		);
	}
}
