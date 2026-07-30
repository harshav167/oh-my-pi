//! WebRTC audio processing (AEC / NS / AGC) for the native live peer.
//!
//! One synchronized processor sees both directions of the call: the playout
//! scheduler analyzes each post-mute render block, and the capture path
//! processes each 10 ms microphone block. Render must be analyzed before the
//! capture block it should cancel, otherwise the echo canceller has nothing to
//! subtract and the speaker interrupts itself through server VAD.
//!
//! Initialization or processing failure is reported once and then bypassed:
//! degraded audio is better than a dropped call.

/// 10 ms of 48 kHz mono PCM, the only block size the APM accepts.
pub const APM_BLOCK_SAMPLES: usize = 480;

/// Echo-cancellation algorithm.
///
/// A closed enum rather than a string: an unrecognized value used to fall
/// through a wildcard and silently disable the stage, so a renamed or mistyped
/// wire value degraded the call instead of failing at the boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveEchoCancellationMode {
	Off,
	/// AEC3, which estimates the render-to-capture delay itself.
	Full,
	/// AECM, which has no estimator and needs the real end-to-end delay.
	Mobile,
}

/// Noise-suppression aggressiveness.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveNoiseSuppressionLevel {
	Off,
	Low,
	Moderate,
	High,
	VeryHigh,
}

/// Digital gain-control mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveAgcMode {
	Off,
	AdaptiveDigital,
	FixedDigital,
}

/// Typed audio-processing settings resolved by the TypeScript host.
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

impl LiveAudioProcessingConfig {
	/// Whether any processing stage is enabled by this configuration.
	pub fn any_enabled(&self) -> bool {
		self.echo_cancellation != LiveEchoCancellationMode::Off
			|| self.noise_suppression != LiveNoiseSuppressionLevel::Off
			|| self.agc != LiveAgcMode::Off
	}
}

/// Render-to-capture delay reported to AECM, which has no delay estimator.
///
/// The adaptive playout target has already elapsed before `analyze_render` sees
/// a block, so only latency *after* the scheduler counts: the speaker ring
/// cushion plus the device's own output buffer.
pub fn mobile_stream_delay_ms(echo_delay_ms: u32, render_latency_ms: u32) -> u16 {
	echo_delay_ms
		.saturating_add(render_latency_ms)
		.min(u32::from(u16::MAX)) as u16
}

#[cfg(target_os = "macos")]
pub use platform::AudioProcessing;
#[cfg(not(target_os = "macos"))]
pub use unsupported::AudioProcessing;

/// Whether this build links a real audio-processing implementation.
pub const fn live_audio_processing_available() -> bool {
	cfg!(target_os = "macos")
}

#[cfg(not(target_os = "macos"))]
mod unsupported {
	use super::LiveAudioProcessingConfig;

	/// Bypass used on platforms without a bundled WebRTC APM.
	pub struct AudioProcessing;

	impl AudioProcessing {
		pub const fn new(
			_config: &LiveAudioProcessingConfig,
			_render_latency_ms: u32,
		) -> (Self, Option<String>) {
			(Self, None)
		}

		pub const fn active(&self) -> bool {
			false
		}

		pub const fn process_capture(&self, _block: &mut [f32]) -> Option<String> {
			None
		}

		pub const fn analyze_render(&self, _block: &[f32]) -> Option<String> {
			None
		}
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::sync::atomic::{AtomicBool, Ordering};

	use webrtc_audio_processing::{
		Processor,
		config::{
			Config, EchoCanceller, GainController, GainController1, GainControllerMode,
			HighPassFilter, NoiseSuppression, NoiseSuppressionLevel,
		},
	};

	use super::{
		APM_BLOCK_SAMPLES, LiveAgcMode, LiveAudioProcessingConfig, LiveEchoCancellationMode,
		LiveNoiseSuppressionLevel, mobile_stream_delay_ms,
	};

	/// One synchronized WebRTC audio processor shared by both media directions.
	///
	/// `Processor` takes `&self` and serializes internally, so both the playout
	/// scheduler and the capture encoder can drive it without an outer lock.
	///
	/// The first runtime failure disables processing for the rest of the call
	/// and is reported once; capture keeps flowing as unmodified PCM.
	pub struct AudioProcessing {
		processor: Option<Processor>,
		disabled:  AtomicBool,
		reported:  AtomicBool,
	}

	impl AudioProcessing {
		/// Build a processor, returning a single human-readable failure reason
		/// when the session must fall back to unprocessed PCM.
		pub fn new(
			config: &LiveAudioProcessingConfig,
			render_latency_ms: u32,
		) -> (Self, Option<String>) {
			let bypass = || Self {
				processor: None,
				disabled:  AtomicBool::new(true),
				reported:  AtomicBool::new(true),
			};
			if !config.any_enabled() {
				return (bypass(), None);
			}
			match Self::build(config, render_latency_ms) {
				Ok(processor) => (
					Self {
						processor: Some(processor),
						disabled:  AtomicBool::new(false),
						reported:  AtomicBool::new(false),
					},
					None,
				),
				Err(error) => (bypass(), Some(error)),
			}
		}

		fn build(
			config: &LiveAudioProcessingConfig,
			render_latency_ms: u32,
		) -> Result<Processor, String> {
			let processor = Processor::new(48_000)
				.map_err(|error| format!("Failed to initialize live audio processing: {error}"))?;
			let echo_canceller = echo_canceller(config, render_latency_ms);
			let noise_suppression = noise_suppression(config);
			// AEC and NS both assume a high-pass-filtered capture path.
			let filter_needed = echo_canceller.is_some() || noise_suppression.is_some();
			processor.set_config(Config {
				echo_canceller,
				noise_suppression,
				gain_controller: gain_controller(config),
				high_pass_filter: filter_needed.then(HighPassFilter::default),
				..Config::default()
			});
			Ok(processor)
		}

		pub fn active(&self) -> bool {
			self.processor.is_some() && !self.disabled.load(Ordering::Acquire)
		}

		/// Take the running processor, or nothing once processing is bypassed.
		fn running(&self, block_len: usize) -> Option<&Processor> {
			if block_len != APM_BLOCK_SAMPLES || self.disabled.load(Ordering::Acquire) {
				return None;
			}
			self.processor.as_ref()
		}

		/// Disable processing for the rest of the call, reporting the reason the
		/// first time only.
		fn bypass(&self, reason: &str) -> Option<String> {
			self.disabled.store(true, Ordering::Release);
			if self.reported.swap(true, Ordering::AcqRel) {
				return None;
			}
			Some(format!("Live audio processing bypassed after a failure: {reason}"))
		}

		/// Process one 10 ms capture block, returning a reason the first time
		/// processing fails.
		///
		/// The frame is processed in scratch so a failed call cannot leave the
		/// caller holding half-processed audio.
		pub fn process_capture(&self, block: &mut [f32]) -> Option<String> {
			let processor = self.running(block.len())?;
			let mut scratch = [0.0f32; APM_BLOCK_SAMPLES];
			scratch.copy_from_slice(block);
			match processor.process_capture_frame([&mut scratch[..]]) {
				Ok(()) => {
					block.copy_from_slice(&scratch);
					None
				},
				Err(error) => self.bypass(&error.to_string()),
			}
		}

		/// Analyze one post-mute 10 ms render block in playout order, returning
		/// a reason the first time processing fails.
		pub fn analyze_render(&self, block: &[f32]) -> Option<String> {
			let processor = self.running(block.len())?;
			let mut render = [0.0f32; APM_BLOCK_SAMPLES];
			render.copy_from_slice(block);
			match processor.process_render_frame([&mut render[..]]) {
				Ok(()) => None,
				Err(error) => self.bypass(&error.to_string()),
			}
		}
	}

	fn echo_canceller(
		config: &LiveAudioProcessingConfig,
		render_latency_ms: u32,
	) -> Option<EchoCanceller> {
		match config.echo_cancellation {
			LiveEchoCancellationMode::Off => None,
			// AEC3 estimates the render-to-capture delay itself unless the user
			// pinned one, which is the better default on unknown hardware.
			LiveEchoCancellationMode::Full => Some(EchoCanceller::Full {
				stream_delay_ms: (config.echo_delay_ms > 0)
					.then(|| config.echo_delay_ms.min(u32::from(u16::MAX)) as u16),
			}),
			// AECM has no estimator, so it needs the real end-to-end delay.
			LiveEchoCancellationMode::Mobile => Some(EchoCanceller::Mobile {
				stream_delay_ms: mobile_stream_delay_ms(config.echo_delay_ms, render_latency_ms),
			}),
		}
	}

	fn noise_suppression(config: &LiveAudioProcessingConfig) -> Option<NoiseSuppression> {
		let level = match config.noise_suppression {
			LiveNoiseSuppressionLevel::Off => return None,
			LiveNoiseSuppressionLevel::Low => NoiseSuppressionLevel::Low,
			LiveNoiseSuppressionLevel::Moderate => NoiseSuppressionLevel::Moderate,
			LiveNoiseSuppressionLevel::High => NoiseSuppressionLevel::High,
			LiveNoiseSuppressionLevel::VeryHigh => NoiseSuppressionLevel::VeryHigh,
		};
		Some(NoiseSuppression { level, ..NoiseSuppression::default() })
	}

	fn gain_controller(config: &LiveAudioProcessingConfig) -> Option<GainController> {
		let mode = match config.agc {
			LiveAgcMode::Off => return None,
			LiveAgcMode::AdaptiveDigital => GainControllerMode::AdaptiveDigital,
			LiveAgcMode::FixedDigital => GainControllerMode::FixedDigital,
		};
		Some(GainController::GainController1(GainController1 {
			mode,
			target_level_dbfs: config.agc_target_level_dbfs.min(31) as u8,
			compression_gain_db: config.agc_compression_gain_db.min(90) as u8,
			enable_limiter: config.agc_limiter,
			analog_gain_controller: None,
		}))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config(
		echo: LiveEchoCancellationMode,
		noise: LiveNoiseSuppressionLevel,
		agc: LiveAgcMode,
	) -> LiveAudioProcessingConfig {
		LiveAudioProcessingConfig {
			echo_cancellation: echo,
			echo_delay_ms: 0,
			noise_suppression: noise,
			agc,
			agc_target_level_dbfs: 3,
			agc_compression_gain_db: 9,
			agc_limiter: true,
		}
	}

	fn all_off() -> LiveAudioProcessingConfig {
		config(LiveEchoCancellationMode::Off, LiveNoiseSuppressionLevel::Off, LiveAgcMode::Off)
	}

	#[test]
	fn processing_is_skipped_only_when_every_stage_is_off() {
		assert!(!all_off().any_enabled());
		assert!(
			config(LiveEchoCancellationMode::Full, LiveNoiseSuppressionLevel::Off, LiveAgcMode::Off)
				.any_enabled()
		);
		assert!(
			config(
				LiveEchoCancellationMode::Off,
				LiveNoiseSuppressionLevel::Moderate,
				LiveAgcMode::Off
			)
			.any_enabled()
		);
		assert!(
			config(
				LiveEchoCancellationMode::Off,
				LiveNoiseSuppressionLevel::Off,
				LiveAgcMode::AdaptiveDigital
			)
			.any_enabled()
		);
	}

	#[test]
	fn a_fully_disabled_configuration_bypasses_without_reporting_failure() {
		let (processing, failure) = AudioProcessing::new(&all_off(), 40);

		assert!(!processing.active());
		assert!(failure.is_none());
	}

	#[test]
	fn bypassed_processing_leaves_capture_samples_untouched() {
		let (processing, _) = AudioProcessing::new(&all_off(), 40);
		let mut block = [0.5f32; APM_BLOCK_SAMPLES];

		processing.analyze_render(&[0.25; APM_BLOCK_SAMPLES]);
		processing.process_capture(&mut block);

		assert!(
			block
				.iter()
				.all(|sample| (*sample - 0.5).abs() < f32::EPSILON)
		);
	}

	#[test]
	fn mobile_aec_delay_adds_only_post_scheduler_latency() {
		// The adaptive playout target has already elapsed, so it must not appear
		// here; only the ring cushion and device buffer do.
		assert_eq!(mobile_stream_delay_ms(60, 40), 100);
		assert_eq!(mobile_stream_delay_ms(0, 40), 40);
		assert_eq!(mobile_stream_delay_ms(u32::MAX, 40), u16::MAX);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn macos_builds_link_a_real_processor() {
		assert!(live_audio_processing_available());

		let (processing, failure) = AudioProcessing::new(
			&config(
				LiveEchoCancellationMode::Full,
				LiveNoiseSuppressionLevel::Moderate,
				LiveAgcMode::AdaptiveDigital,
			),
			40,
		);

		assert!(failure.is_none(), "bundled APM must initialize: {failure:?}");
		assert!(processing.active());
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn render_analysis_before_capture_processing_alters_the_capture_block() {
		let (processing, _) = AudioProcessing::new(
			&config(LiveEchoCancellationMode::Full, LiveNoiseSuppressionLevel::High, LiveAgcMode::Off),
			40,
		);
		let render: Vec<f32> = (0..APM_BLOCK_SAMPLES)
			.map(|index| (index as f32 * 0.05).sin() * 0.8)
			.collect();
		let mut capture = render.clone();

		// Feeding the same signal as render and capture is pure echo: with the
		// canceller running, the processed capture must not come back untouched.
		for _ in 0..50 {
			processing.analyze_render(&render);
			capture.copy_from_slice(&render);
			processing.process_capture(&mut capture);
		}

		assert!(
			capture
				.iter()
				.zip(&render)
				.any(|(processed, original)| (processed - original).abs() > 1e-6),
			"echo cancellation must modify a capture block that is pure render echo"
		);
	}
}
