//! Cross-platform microphone capture and streaming speaker playback.
//!
//! miniaudio owns platform device discovery, format conversion, channel mixing,
//! and resampling. The N-API classes expose one stable mono `f32` contract to
//! TypeScript while the internal playback stream is shared with native WebRTC.

use std::{
	collections::{HashMap, VecDeque},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
	},
};

use maudio::{
	audio::{performance::PerformanceProfile, sample_rate::SampleRate},
	backend::Backend,
	context::{ContextBuilder, ContextOps, EnumerateControl},
	device::{
		Device,
		device_builder::{DeviceBuilder, DeviceBuilderOps},
		device_id::DeviceId,
		device_info::DeviceInfo,
	},
};
use parking_lot::Mutex;
use tokio::sync::Notify;

const AUDIO_CHANNELS: u32 = 1;
// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
pub const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
pub const PLAYBACK_PERIOD_MS: u32 = 20;
// miniaudio's PulseAudio backend reserves three periods. Android's OpenSL ES
// source emits 125 ms fragments, so Linux capture needs at least 150 ms queued.
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
// PulseAudio can retain its default three periods after the producer closes.
// Wait for all of them before stopping the device so the tail reaches the sink.
#[cfg(target_os = "linux")]
const PLAYBACK_DRAIN_CALLBACKS: usize = 3;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_DRAIN_CALLBACKS: usize = 2;
/// Memory ceiling for the general-purpose playback queue, in seconds of audio.
/// Long enough that no realistic synthesized utterance is truncated, short
/// enough that a runaway producer cannot exhaust memory. Live calls pass their
/// own much tighter bound.
pub const PLAYBACK_MAX_QUEUE_SECONDS: usize = 120;

#[cfg(target_os = "macos")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::CoreAudio];
#[cfg(target_os = "windows")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Wasapi];
#[cfg(target_os = "linux")]
const AUDIO_BACKENDS: &[Backend] = &[Backend::PulseAudio, Backend::Alsa, Backend::Jack];
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const AUDIO_BACKENDS: &[Backend] = &[Backend::Sndio, Backend::Audio4, Backend::Oss];

/// Engine-level result, shared with the rest of the crate.
pub type NativeResult<T> = crate::VoiceResult<T>;

#[derive(Clone, Copy)]
pub enum AudioDeviceKind {
	Input,
	Output,
}

impl AudioDeviceKind {
	const fn value(self) -> &'static str {
		match self {
			Self::Input => "input",
			Self::Output => "output",
		}
	}
}

/// One selectable native audio endpoint.
pub struct AudioDeviceInfo {
	pub id:         String,
	pub name:       String,
	pub kind:       String,
	pub is_default: bool,
}

fn audio_context() -> NativeResult<maudio::context::Context> {
	let mut builder = ContextBuilder::new();
	builder.preferred_backends(AUDIO_BACKENDS);
	builder
		.build()
		.map_err(|error| format!("Failed to enumerate audio devices: {error}"))
}

fn encode_hex(bytes: &[u8]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut encoded = String::with_capacity(bytes.len() * 2);
	for &byte in bytes {
		encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
		encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
	}
	encoded
}

fn device_key(info: &DeviceInfo) -> String {
	// SAFETY: maudio declares `DeviceInfo` as `repr(transparent)` over
	// `maudio_sys::ma_device_info`; the borrow remains tied to `info`.
	let raw = unsafe { &*std::ptr::from_ref(info).cast::<maudio_sys::ffi::ma_device_info>() };
	let id = &raw.id;
	// SAFETY: miniaudio returns a fully initialized fixed-size `ma_device_id`.
	// We only copy its object representation and retain no borrowed bytes.
	let bytes = unsafe {
		std::slice::from_raw_parts(std::ptr::from_ref(id).cast::<u8>(), std::mem::size_of_val(id))
	};
	encode_hex(bytes)
}

fn next_occurrence(counts: &mut HashMap<String, usize>, name: &str) -> usize {
	let occurrence = counts.entry(name.to_owned()).or_default();
	let value = *occurrence;
	*occurrence += 1;
	value
}

pub fn resolve_audio_device(
	kind: AudioDeviceKind,
	configured_id: &str,
) -> NativeResult<Option<DeviceId>> {
	if configured_id.is_empty() {
		return Ok(None);
	}
	let devices = audio_context()?
		.get_devices()
		.map_err(|error| format!("Failed to enumerate {} audio devices: {error}", kind.value()))?;
	let candidates = match kind {
		AudioDeviceKind::Input => &devices.capture,
		AudioDeviceKind::Output => &devices.playback,
	};
	candidates
		.iter()
		.find(|info| device_key(info) == configured_id)
		.map(|info| Some(info.device_id()))
		.ok_or_else(|| {
			format!("Configured {} audio device is unavailable: {configured_id}", kind.value())
		})
}

/// Enumerate selectable input and output devices.
pub fn list_audio_devices() -> NativeResult<Vec<AudioDeviceInfo>> {
	let context = audio_context()?;
	let devices = context
		.get_devices()
		.map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
	let mut default_input: Option<(String, usize)> = None;
	let mut default_output: Option<(String, usize)> = None;
	let mut input_counts = HashMap::new();
	let mut output_counts = HashMap::new();
	context
		.enumerate_devices(|kind, info| {
			let (counts, default) = match kind {
				maudio::device::device_type::DeviceType::Capture => {
					(&mut input_counts, &mut default_input)
				},
				maudio::device::device_type::DeviceType::Playback => {
					(&mut output_counts, &mut default_output)
				},
				_ => return EnumerateControl::Continue,
			};
			let occurrence = next_occurrence(counts, info.name());
			if info.is_default() {
				*default = Some((info.name().to_owned(), occurrence));
			}
			EnumerateControl::Continue
		})
		.map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
	let mut result = Vec::with_capacity(devices.capture.len() + devices.playback.len());
	let mut input_counts = HashMap::new();
	for info in &devices.capture {
		let occurrence = next_occurrence(&mut input_counts, info.device_name());
		result.push(AudioDeviceInfo {
			id:         device_key(info),
			name:       info.device_name().to_owned(),
			kind:       AudioDeviceKind::Input.value().to_owned(),
			is_default: default_input.as_ref() == Some(&(info.device_name().to_owned(), occurrence)),
		});
	}
	let mut output_counts = HashMap::new();
	for info in &devices.playback {
		let occurrence = next_occurrence(&mut output_counts, info.device_name());
		result.push(AudioDeviceInfo {
			id:         device_key(info),
			name:       info.device_name().to_owned(),
			kind:       AudioDeviceKind::Output.value().to_owned(),
			is_default: default_output.as_ref() == Some(&(info.device_name().to_owned(), occurrence)),
		});
	}
	Ok(result)
}

/// Shared state for one playback device, including its bounded render ring.
pub struct PlaybackState {
	gain_bits:          AtomicU32,
	drained:            AtomicBool,
	stopped:            AtomicBool,
	input_closed:       AtomicBool,
	muted:              AtomicBool,
	underruns:          AtomicU64,
	dropped_samples:    AtomicU64,
	max_queued_samples: AtomicUsize,
	capacity:           usize,
	ring:               Mutex<VecDeque<f32>>,
	notify:             Notify,
}

impl PlaybackState {
	fn new(capacity: usize) -> Self {
		Self {
			gain_bits:          AtomicU32::new(1.0f32.to_bits()),
			drained:            AtomicBool::new(false),
			stopped:            AtomicBool::new(false),
			input_closed:       AtomicBool::new(false),
			muted:              AtomicBool::new(false),
			underruns:          AtomicU64::new(0),
			dropped_samples:    AtomicU64::new(0),
			max_queued_samples: AtomicUsize::new(0),
			capacity:           capacity.max(1),
			ring:               Mutex::new(VecDeque::new()),
			notify:             Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	/// Mute rendering without pausing consumption, so muted speech never
	/// replays.
	fn set_muted(&self, muted: bool) {
		self.muted.store(muted, Ordering::Release);
	}

	/// Append render samples, dropping the oldest unplayed audio on overrun.
	fn push(&self, samples: &[f32]) {
		if samples.is_empty() {
			return;
		}
		let mut ring = self.ring.lock();
		ring.extend(samples.iter().copied());
		if ring.len() > self.capacity {
			let excess = ring.len() - self.capacity;
			ring.drain(..excess);
			self
				.dropped_samples
				.fetch_add(excess as u64, Ordering::Relaxed);
		}
		let queued = ring.len();
		drop(ring);
		self.max_queued_samples.fetch_max(queued, Ordering::Relaxed);
	}

	fn queued(&self) -> usize {
		self.ring.lock().len()
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	pub async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}
}

/// Producer endpoint for one native playback device.
#[derive(Clone)]
pub struct PlaybackWriter {
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue mono floating-point samples without blocking the caller.
	pub fn write(&self, samples: &[f32]) -> NativeResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		self.state.push(samples);
		Ok(())
	}

	/// Samples queued but not yet handed to the device callback.
	pub fn queued_samples(&self) -> usize {
		self.state.queued()
	}

	/// Mute rendering while still consuming queued audio.
	pub fn set_muted(&self, muted: bool) {
		self.state.set_muted(muted);
	}

	/// Callback-observed starvation count.
	pub fn underruns(&self) -> u64 {
		self.state.underruns.load(Ordering::Relaxed)
	}

	/// Samples discarded because the render ring was full.
	pub fn dropped_samples(&self) -> u64 {
		self.state.dropped_samples.load(Ordering::Relaxed)
	}

	/// High-water mark of the render ring.
	pub fn max_queued_samples(&self) -> usize {
		self.state.max_queued_samples.load(Ordering::Relaxed)
	}
}

/// Callback invoked with the RMS of samples actually rendered to the speaker.
pub type RenderLevelCallback = Arc<dyn Fn(f64) + Send + Sync>;

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub struct PlaybackStream {
	device: Option<Device<f32>>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
}

impl PlaybackStream {
	/// Open and start the selected speaker at the requested logical sample rate.
	pub fn start(
		sample_rate: u32,
		output_device_id: &str,
		capacity_samples: usize,
		on_level: Option<RenderLevelCallback>,
	) -> NativeResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let output_device = resolve_audio_device(AudioDeviceKind::Output, output_device_id)?;
		let state = Arc::new(PlaybackState::new(capacity_samples));
		let callback_state = Arc::clone(&state);
		let mut cursor = PlaybackCursor::default();
		let mut level = RenderLevel::new(u32::from(sample_rate));
		let mut builder = DeviceBuilder::playback().f32();
		builder
			.sample_rate(sample_rate)
			.playback_channels(AUDIO_CHANNELS)
			.period_size_millis(PLAYBACK_PERIOD_MS)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS);
		if let Some(device_id) = output_device.as_ref() {
			builder.playback_device_id(device_id);
		}
		let mut device = builder
			.with_callback(move |_device, output| {
				fill_playback(output, &callback_state, &mut cursor);
				if let Some(on_level) = on_level.as_ref() {
					level.observe(output, on_level.as_ref());
				}
			})
			.map_err(|error| format!("Failed to open the default speaker: {error}"))?;
		device
			.device_start()
			.map_err(|error| format!("Failed to start speaker playback: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { state: Arc::clone(&state) }),
			state,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub fn writer(&self) -> NativeResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	pub fn finish_input(&mut self) {
		self.writer.take();
		self.state.input_closed.store(true, Ordering::Release);
	}

	pub fn set_gain(&self, gain: f32) -> NativeResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub fn stop(&mut self) -> NativeResult<()> {
		self.writer.take();
		self.state.input_closed.store(true, Ordering::Release);
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device
			.device_stop()
			.map_err(|error| format!("Failed to stop speaker playback: {error}"))
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

fn audio_sample_rate(sample_rate: u32) -> NativeResult<SampleRate> {
	SampleRate::try_from(sample_rate)
		.map_err(|error| format!("Unsupported audio sample rate {sample_rate}: {error}"))
}

/// Rolling RMS of post-mute samples handed to the speaker.
struct RenderLevel {
	window:      usize,
	sum_squares: f64,
	samples:     usize,
}

impl RenderLevel {
	fn new(sample_rate: u32) -> Self {
		Self { window: (sample_rate as usize / 20).max(1), sum_squares: 0.0, samples: 0 }
	}

	fn observe(&mut self, rendered: &[f32], emit: &dyn Fn(f64)) {
		let mut offset = 0;
		while offset < rendered.len() {
			let take = (self.window - self.samples).min(rendered.len() - offset);
			for &sample in &rendered[offset..offset + take] {
				let sample = f64::from(sample);
				self.sum_squares = sample.mul_add(sample, self.sum_squares);
			}
			self.samples += take;
			offset += take;
			if self.samples == self.window {
				emit((self.sum_squares / self.samples as f64).sqrt());
				self.sum_squares = 0.0;
				self.samples = 0;
			}
		}
	}
}

/// Per-callback render cursor kept outside the shared state.
#[derive(Default)]
struct PlaybackCursor {
	empty_callbacks: usize,
	rendering:       bool,
}

/// Render one device period from the bounded ring, counting starvation.
///
/// Muted playback still consumes queued samples so speech cannot leak or
/// replay after unmute. An idle ring is not an underrun; only a stream that
/// was rendering and then ran dry counts.
fn fill_playback(output: &mut [f32], state: &PlaybackState, cursor: &mut PlaybackCursor) {
	output.fill(0.0);
	if state.stopped.load(Ordering::Acquire) {
		return;
	}

	let gain = state.gain();
	let muted = state.muted.load(Ordering::Acquire);
	let mut ring = state.ring.lock();
	let rendered = ring.len().min(output.len());
	if muted {
		ring.drain(..rendered);
	} else {
		for slot in output.iter_mut().take(rendered) {
			*slot = ring.pop_front().unwrap_or(0.0) * gain;
		}
	}
	let remaining = ring.len();
	drop(ring);

	let starved = rendered < output.len();
	if starved && (rendered > 0 || cursor.rendering) {
		state.underruns.fetch_add(1, Ordering::Relaxed);
	}
	cursor.rendering = rendered > 0;
	if starved && remaining == 0 && state.input_closed.load(Ordering::Acquire) {
		cursor.empty_callbacks += 1;
		if cursor.empty_callbacks >= PLAYBACK_DRAIN_CALLBACKS {
			state.mark_drained();
		}
		return;
	}
	cursor.empty_callbacks = 0;
}

/// Internal microphone capture that hands borrowed mono `f32` blocks to a
/// native closure without crossing the N-API boundary.
pub struct CaptureStream {
	device: Option<Device<f32>>,
}

impl CaptureStream {
	/// Open the selected microphone and stream mono `f32` at `sample_rate`.
	pub fn start(
		sample_rate: u32,
		input_device_id: &str,
		mut on_samples: impl FnMut(&[f32]) + Send + 'static,
	) -> NativeResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let input_device = resolve_audio_device(AudioDeviceKind::Input, input_device_id)?;
		let mut builder = DeviceBuilder::capture().f32();
		builder
			.sample_rate(sample_rate)
			.capture_channels(AUDIO_CHANNELS)
			.period_size_millis(CAPTURE_PERIOD_MS)
			.performance_profile(PerformanceProfile::LowLatency)
			.backends(AUDIO_BACKENDS);
		if let Some(device_id) = input_device.as_ref() {
			builder.capture_device_id(device_id);
		}
		let mut device = builder
			.with_callback(move |_device, samples| {
				if !samples.is_empty() {
					on_samples(samples);
				}
			})
			.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		device
			.device_start()
			.map_err(|error| format!("Failed to start microphone capture: {error}"))?;
		Ok(Self { device: Some(device) })
	}

	/// Stop capture immediately and release the microphone.
	pub fn stop(&mut self) -> NativeResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device
			.device_stop()
			.map_err(|error| format!("Failed to stop microphone capture: {error}"))
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		mem::forget,
		sync::atomic::AtomicUsize,
		thread::sleep,
		time::{Duration, Instant},
	};

	use super::*;

	/// Upstream's `playback_preserves_chunk_order_and_applies_render_gain`,
	/// ported to this engine's seam. It drove `fill_playback` over a flume
	/// receiver with an external cursor; rendering now reads a bounded ring on
	/// `PlaybackState` through a `PlaybackCursor`. Same contract: queued order
	/// survives, render gain is applied at render time, short reads pad with
	/// silence, and drain latches only once input is closed and the ring has
	/// stayed empty for `PLAYBACK_DRAIN_CALLBACKS` callbacks.
	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = PlaybackState::new(64);
		state.set_gain(0.5);
		state.push(&[1.0, -1.0]);
		state.push(&[0.5, -0.5]);
		let mut cursor = PlaybackCursor::default();
		let mut output = [9.0; 5];

		fill_playback(&mut output, &state, &mut cursor);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));

		// Drain only counts once the producer is gone; until then an empty ring is
		// just an idle stream.
		state.input_closed.store(true, Ordering::Release);
		let mut silence = [1.0; 2];
		for callback in 1..=PLAYBACK_DRAIN_CALLBACKS {
			silence.fill(1.0);
			fill_playback(&mut silence, &state, &mut cursor);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(state.drained.load(Ordering::Acquire), callback >= PLAYBACK_DRAIN_CALLBACKS);
		}
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let capacity = 16_000 * PLAYBACK_MAX_QUEUE_SECONDS;
		let mut stream =
			PlaybackStream::start(16_000, "", capacity, None).expect("default playback device starts");
		stream.stop().expect("default playback device stops");
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut stream = CaptureStream::start(16_000, "", move |_samples| {
			callback_count.fetch_add(1, Ordering::Relaxed);
		})
		.expect("default capture device starts");

		let deadline = Instant::now() + Duration::from_secs(5);
		while callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
			sleep(Duration::from_millis(20));
		}
		if callbacks.load(Ordering::Relaxed) == 0 {
			forget(stream);
			panic!("capture device started but delivered no frames within five seconds");
		}
		stream.stop().expect("capture device stops");
	}
}
