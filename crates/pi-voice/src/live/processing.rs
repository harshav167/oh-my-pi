use std::{
	collections::VecDeque,
	time::{Duration, Instant},
};

use opus::{Application, Channels, Encoder};
use sonora::{
	AudioProcessing, StreamConfig,
	config::{AdaptiveDigital, EchoCanceller, GainController2, NoiseSuppression},
};

use crate::VoiceResult;

pub(super) const SAMPLE_RATE: u32 = 48_000;
pub(super) const PROCESSING_BLOCK_SAMPLES: usize = 480;
pub(super) const OPUS_FRAME_SAMPLES: usize = 960;
pub(super) const MAX_ENCODED_OPUS_BYTES: usize = 1_275;
pub(super) const MAX_PROCESSING_DELAY: Duration = Duration::from_millis(500);
pub(super) const PROCESSING_LATE: &str = "voice processing fell behind";
const CAPTURE_GAP_TOLERANCE: Duration = Duration::from_millis(20);

pub(super) struct EncodedAudio {
	pub(super) data: Vec<u8>,
	pub(super) at:   Instant,
}

pub(super) struct Processor {
	capture:      VecDeque<f32>,
	capture_at:   Option<Instant>,
	capture_end:  Option<Instant>,
	cutoff:       Instant,
	render:       VecDeque<f32>,
	render_end:   Option<Instant>,
	render_delay: i64,
	pending:      Vec<f32>,
	pending_at:   Option<Instant>,
	input_level:  RmsMeter,
	apm:          AudioProcessing,
	encoder:      Encoder,
}

impl Processor {
	pub(super) fn new() -> VoiceResult<Self> {
		let encoder = Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip)
			.map_err(|_| "failed to create voice encoder".to_owned())?;
		Ok(Self {
			capture: VecDeque::new(),
			capture_at: None,
			capture_end: None,
			cutoff: Instant::now(),
			render: VecDeque::new(),
			render_end: None,
			render_delay: 0,
			pending: Vec::with_capacity(OPUS_FRAME_SAMPLES),
			pending_at: None,
			input_level: RmsMeter::new(OPUS_FRAME_SAMPLES),
			apm: AudioProcessing::builder()
				.config(sonora::Config {
					echo_canceller: Some(EchoCanceller::default()),
					noise_suppression: Some(NoiseSuppression::default()),
					gain_controller2: Some(GainController2 {
						adaptive_digital: Some(AdaptiveDigital::default()),
						..Default::default()
					}),
					..Default::default()
				})
				.capture_config(StreamConfig::new(SAMPLE_RATE, 1))
				.render_config(StreamConfig::new(SAMPLE_RATE, 1))
				.build(),
			encoder,
		})
	}

	/// Reset capture, render, APM, and codec history after a mute transition
	/// or late processing. Audio captured before the reset is ignored, so
	/// backlog queued across an unmute is never transmitted.
	pub(super) fn reset(&mut self) -> VoiceResult<()> {
		*self = Self::new()?;
		Ok(())
	}

	/// Feed speaker output that reaches the device at `at`, analyzed at
	/// `now`. The signed lead of the latest block's presentation time over
	/// `now` is the render half of the echo canceller's stream delay.
	pub(super) fn render(
		&mut self,
		samples: &[f32],
		at: Instant,
		now: Instant,
	) -> Result<(), &'static str> {
		if samples.iter().any(|sample| !sample.is_finite())
			|| self.render.len().saturating_add(samples.len()) > SAMPLE_RATE as usize
		{
			return Err("invalid voice echo reference");
		}
		self.render_end = Some(at + samples_duration(samples.len()));
		self.render.extend(samples.iter().copied());
		while self.render.len() >= PROCESSING_BLOCK_SAMPLES {
			let end = self
				.render_end
				.ok_or("voice echo reference timestamp unavailable")?;
			let block_at = end
				.checked_sub(samples_duration(self.render.len()))
				.unwrap_or(end);
			let mut input = [0.0; PROCESSING_BLOCK_SAMPLES];
			for sample in &mut input {
				*sample = self
					.render
					.pop_front()
					.ok_or("voice echo reference backlog changed")?;
			}
			let mut output = [0.0; PROCESSING_BLOCK_SAMPLES];
			self
				.apm
				.process_render_f32(&[&input], &mut [&mut output])
				.map_err(|_| "voice echo reference failed")?;
			self.render_delay = if block_at > now {
				block_at.duration_since(now).as_millis() as i64
			} else {
				-(now.duration_since(block_at).as_millis() as i64)
			};
		}
		Ok(())
	}

	/// Discard reference history and its delay without touching capture or
	/// APM state, after references were dropped or went stale.
	pub(super) fn reset_render(&mut self) {
		self.render.clear();
		self.render_end = None;
		self.render_delay = 0;
	}

	/// Process microphone audio whose first sample was captured at `at`.
	pub(super) fn capture(
		&mut self,
		samples: &[f32],
		at: Instant,
		now: Instant,
		mut on_level: impl FnMut(f64),
	) -> Result<Vec<EncodedAudio>, &'static str> {
		if samples.is_empty() || at < self.cutoff {
			return Ok(Vec::new());
		}
		if samples.iter().any(|sample| !sample.is_finite()) {
			return Err("invalid captured voice audio");
		}
		if self
			.capture_end
			.is_some_and(|end| at.saturating_duration_since(end) > CAPTURE_GAP_TOLERANCE)
		{
			// Drop APM and half-packet history without advancing the cutoff:
			// this chunk may already have waited in the queue.
			let cutoff = self.cutoff;
			self
				.reset()
				.map_err(|_| "failed to reset voice processor")?;
			self.cutoff = cutoff;
		}
		if self.capture.len().saturating_add(samples.len()) > SAMPLE_RATE as usize {
			return Err("voice capture backlog exceeded");
		}
		if self.capture.is_empty() {
			self.capture_at = Some(at);
		}
		self.capture_end = Some(at + samples_duration(samples.len()));
		self.capture.extend(samples.iter().copied());

		let mut encoded = Vec::with_capacity(samples.len() / OPUS_FRAME_SAMPLES);
		while self.capture.len() >= PROCESSING_BLOCK_SAMPLES {
			let block_at = self
				.capture_at
				.ok_or("voice capture timestamp unavailable")?;
			let capture_age = now.saturating_duration_since(block_at);
			if capture_age > MAX_PROCESSING_DELAY {
				return Err(PROCESSING_LATE);
			}
			// A render lead past the deadline (remote PulseAudio output latency)
			// only weakens the hint: sonora caps it at 500 ms too, and AEC3 keeps
			// estimating the actual echo-path delay, so capture continues.
			let delay = (capture_age.as_millis() as i64 + self.render_delay)
				.clamp(0, MAX_PROCESSING_DELAY.as_millis() as i64);
			self
				.apm
				.set_stream_delay_ms(delay as i32)
				.map_err(|_| "invalid voice echo delay")?;

			let mut input = [0.0; PROCESSING_BLOCK_SAMPLES];
			for sample in &mut input {
				*sample = self
					.capture
					.pop_front()
					.ok_or("voice capture backlog changed")?;
			}
			let mut output = [0.0; PROCESSING_BLOCK_SAMPLES];
			self
				.apm
				.process_capture_f32(&[&input], &mut [&mut output])
				.map_err(|_| "voice capture processing failed")?;
			if output.iter().any(|sample| !sample.is_finite()) {
				return Err("invalid processed voice audio");
			}
			self.input_level.push(&output, &mut on_level);
			if self.pending.is_empty() {
				self.pending_at = Some(block_at);
			}
			self.pending.extend_from_slice(&output);
			self.capture_at =
				(!self.capture.is_empty()).then_some(block_at + Duration::from_millis(10));

			if self.pending.len() == OPUS_FRAME_SAMPLES {
				let mut data = vec![0; MAX_ENCODED_OPUS_BYTES];
				let len = self
					.encoder
					.encode_float(&self.pending, &mut data)
					.map_err(|_| "failed to encode voice audio")?;
				data.truncate(len);
				encoded.push(EncodedAudio {
					data,
					at: self
						.pending_at
						.ok_or("voice packet timestamp unavailable")?,
				});
				self.pending.clear();
				self.pending_at = None;
			}
		}
		Ok(encoded)
	}
}

fn samples_duration(samples: usize) -> Duration {
	Duration::from_secs_f64(samples as f64 / f64::from(SAMPLE_RATE))
}

pub(super) struct RmsMeter {
	window_samples: usize,
	sum_squares:    f64,
	samples:        usize,
}

impl RmsMeter {
	pub(super) fn new(window_samples: usize) -> Self {
		Self { window_samples: window_samples.max(1), sum_squares: 0.0, samples: 0 }
	}

	pub(super) const fn reset(&mut self) {
		self.sum_squares = 0.0;
		self.samples = 0;
	}

	pub(super) fn push(&mut self, samples: &[f32], mut report: impl FnMut(f64)) {
		let mut offset = 0;
		while offset < samples.len() {
			let take = (self.window_samples - self.samples).min(samples.len() - offset);
			for &sample in &samples[offset..offset + take] {
				let sample = f64::from(sample);
				self.sum_squares = sample.mul_add(sample, self.sum_squares);
			}
			self.samples += take;
			offset += take;
			if self.samples == self.window_samples {
				report(
					(self.sum_squares / self.samples as f64)
						.sqrt()
						.clamp(0.0, 1.0),
				);
				self.reset();
			}
		}
	}
}

#[cfg(test)]
#[path = "processing_tests.rs"]
mod tests;
