//! Cross-platform microphone capture and streaming speaker playback.
//!
//! The per-platform backends in [`crate::device`] own device access, format
//! conversion, channel mixing, and resampling. The engine exposes one stable
//! mono `f32` contract: the N-API classes in pi-natives adapt it to
//! TypeScript, and [`crate::live`] shares [`PlaybackStream`] for remote-audio
//! rendering.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	time::Instant,
};

use flume::{TryRecvError, TrySendError};
use tokio::sync::Notify;

use crate::{
	VoiceResult,
	device::{CaptureDevice, DeviceConfig, PlaybackDevice, playback_drain_periods},
};

// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
/// Live playback may accumulate a short cushion. Older chunks are discarded
/// rather than allowing network bursts to create an ever-larger audio delay.
const LIVE_PLAYBACK_QUEUE_CHUNKS: usize = 6;
// Backends queue up to `device::playback_drain_periods` periods (three for
// AudioQueue buffers/WASAPI padding; PulseAudio scales this with the widened
// remote/`PULSE_LATENCY_MSEC` backlog — see that function). Draining needs
// that many silence periods COMMITTED to the OS behind the tail: once the
// last is accepted into the backend's FIFO, everything ahead of it has
// played. The callback that marks drained races teardown — on Linux the
// delivery gate may cancel that callback's own write after `wait_for_drain`
// wakes — so count one extra empty callback: the racy, possibly-uncommitted
// write is always the last one, which is margin rather than accounted flush.
const PLAYBACK_DRAIN_MARGIN_CALLBACKS: usize = 1;

/// Receives every buffer exactly as written to the speaker (after gain,
/// silence included) with the instant its first sample reaches the device.
/// Runs on the audio thread and must not block.
pub(crate) type PlaybackTap = Box<dyn FnMut(&[f32], Instant) + Send + 'static>;

/// Move `epoch` to the disabled (odd) or enabled (even) parity. Every
/// transition advances to a fresh epoch, so audio tagged before a
/// disable/enable cycle can never match again. Returns whether it changed.
pub(crate) fn set_epoch_disabled(epoch: &AtomicU64, disabled: bool) -> VoiceResult<bool> {
	let mut current = epoch.load(Ordering::Acquire);
	loop {
		if (current % 2 == 1) == disabled {
			return Ok(false);
		}
		let next = current
			.checked_add(1)
			.ok_or_else(|| "Audio epoch exhausted".to_owned())?;
		match epoch.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
			Ok(_) => return Ok(true),
			Err(actual) => current = actual,
		}
	}
}

/// Shared render-time state for one playback device: gain, drain, stop.
///
/// Held as an `Arc` by both the stream and its N-API wrapper so
/// [`PlaybackState::wait_for_drain`] can outlive the stream lock.
pub struct PlaybackState {
	gain_bits:     AtomicU32,
	drained:       AtomicBool,
	stopped:       AtomicBool,
	speaker_epoch: AtomicU64,
	notify:        Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits:     AtomicU32::new(1.0f32.to_bits()),
			drained:       AtomicBool::new(false),
			stopped:       AtomicBool::new(false),
			speaker_epoch: AtomicU64::new(0),
			notify:        Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
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

	/// Resolve once every queued sample reached the speaker (or the stream
	/// stopped). Used by the N-API `AudioPlayback.end()` graceful-close path.
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

/// Wakes drain waiters when the backend drops the fill callback (device loss
/// or stop) so `wait_for_drain` can never outlive the render path.
struct FillGuard {
	state: Arc<PlaybackState>,
}

impl Drop for FillGuard {
	fn drop(&mut self) {
		self.state.mark_stopped();
	}
}

struct PlaybackChunk {
	samples: Vec<f32>,
	epoch:   u64,
}

/// Producer endpoint for one native playback device. Cloned into the WebRTC
/// remote-audio decoder so it can feed the same speaker stream.
#[derive(Clone)]
pub struct PlaybackWriter {
	tx:       flume::Sender<PlaybackChunk>,
	flush_rx: Option<flume::Receiver<PlaybackChunk>>,
	state:    Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue mono floating-point samples without blocking the caller. Audio
	/// written while the speaker is suppressed is discarded.
	pub fn write(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		let epoch = self.state.speaker_epoch.load(Ordering::Acquire);
		if !epoch.is_multiple_of(2) {
			return Ok(());
		}
		let chunk = PlaybackChunk { samples: samples.to_vec(), epoch };
		match self.tx.try_send(chunk) {
			Ok(()) => Ok(()),
			Err(TrySendError::Full(chunk)) => {
				let Some(flush_rx) = &self.flush_rx else {
					// Ordinary playback is intentionally unbounded; a bounded
					// writer always carries the queue used for live recovery.
					return Err("Native audio playback queue is full".to_owned());
				};
				while flush_rx.try_recv().is_ok() {}
				self
					.tx
					.try_send(chunk)
					.map_err(|_| "Native audio playback is closed".to_owned())
			},
			Err(TrySendError::Disconnected(_)) => Err("Native audio playback is closed".to_owned()),
		}
	}
}

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub struct PlaybackStream {
	device:   Option<PlaybackDevice>,
	writer:   Option<PlaybackWriter>,
	state:    Arc<PlaybackState>,
	flush_rx: flume::Receiver<PlaybackChunk>,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub fn start(sample_rate: u32) -> VoiceResult<Self> {
		Self::open(sample_rate, None)
	}

	/// Like [`Self::start`], additionally handing every rendered buffer and
	/// its device presentation time to `reference` so echo cancellation sees
	/// exactly what the speaker played.
	pub(crate) fn start_with_reference(
		sample_rate: u32,
		reference: PlaybackTap,
	) -> VoiceResult<Self> {
		Self::open(sample_rate, Some(reference))
	}

	fn open(sample_rate: u32, reference: Option<PlaybackTap>) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let config = DeviceConfig { sample_rate, period_ms: PLAYBACK_PERIOD_MS };
		let state = Arc::new(PlaybackState::new());
		let is_live = reference.is_some();
		let (tx, rx) = if is_live {
			flume::bounded::<PlaybackChunk>(LIVE_PLAYBACK_QUEUE_CHUNKS)
		} else {
			flume::unbounded::<PlaybackChunk>()
		};
		let flush_rx = rx.clone();
		let writer_flush_rx = is_live.then(|| rx.clone());
		let mut render = PlaybackRender::new(
			rx,
			Arc::clone(&state),
			(playback_drain_periods(config) as usize) + PLAYBACK_DRAIN_MARGIN_CALLBACKS,
			reference,
		);
		// The guard travels inside the fill closure: if the backend drops the
		// callback for any reason (worker exit on device loss, stop), waiters
		// blocked in `wait_for_drain` wake instead of hanging forever.
		let guard = FillGuard { state: Arc::clone(&state) };
		let device = PlaybackDevice::start(
			config,
			Box::new(move |output, presented_at| {
				let _ = &guard;
				render.fill(output, presented_at);
			}),
		)
		.map_err(|error| format!("Failed to open the default speaker: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { tx, flush_rx: writer_flush_rx, state: Arc::clone(&state) }),
			state,
			flush_rx,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub fn writer(&self) -> VoiceResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	pub(crate) fn set_suppressed(&self, suppressed: bool) -> VoiceResult<()> {
		set_epoch_disabled(&self.state.speaker_epoch, suppressed)?;
		if suppressed {
			while self.flush_rx.try_recv().is_ok() {}
		}
		Ok(())
	}

	/// Shared render-time state, cloned out so callers can await drain after
	/// releasing the stream lock.
	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	/// Close the producer side so the render callback can detect drain.
	pub fn finish_input(&mut self) {
		self.writer.take();
	}

	/// Scale audio at render time so gain changes affect already queued
	/// samples. Rejects non-finite gains; negative gains clamp to silence.
	pub fn set_gain(&self, gain: f32) -> VoiceResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Bounds the logical rate to what OS converters accept before device open.
fn audio_sample_rate(sample_rate: u32) -> VoiceResult<u32> {
	if !(8_000..=384_000).contains(&sample_rate) {
		return Err(format!("Unsupported audio sample rate {sample_rate}"));
	}
	Ok(sample_rate)
}

/// Audio-thread side of one playback stream: pulls queued chunks into each
/// device buffer, then reports the finished buffer to the reference tap.
struct PlaybackRender {
	rx:              flume::Receiver<PlaybackChunk>,
	state:           Arc<PlaybackState>,
	current:         Vec<f32>,
	cursor:          usize,
	current_epoch:   u64,
	empty_callbacks: usize,
	drain_callbacks: usize,
	reference:       Option<PlaybackTap>,
}

impl PlaybackRender {
	fn new(
		rx: flume::Receiver<PlaybackChunk>,
		state: Arc<PlaybackState>,
		drain_callbacks: usize,
		reference: Option<PlaybackTap>,
	) -> Self {
		Self {
			rx,
			state,
			current: Vec::new(),
			cursor: 0,
			current_epoch: 0,
			empty_callbacks: 0,
			drain_callbacks,
			reference,
		}
	}

	fn fill(&mut self, output: &mut [f32], presented_at: Instant) {
		self.write(output);
		if let Some(reference) = self.reference.as_mut() {
			reference(output, presented_at);
		}
	}

	fn write(&mut self, output: &mut [f32]) {
		output.fill(0.0);
		if self.state.stopped.load(Ordering::Acquire) {
			return;
		}

		let gain = self.state.gain();
		let mut output_offset = 0;
		while output_offset < output.len() {
			let epoch = self.state.speaker_epoch.load(Ordering::Acquire);
			if !epoch.is_multiple_of(2) {
				self.current.clear();
				self.cursor = 0;
				while self.rx.try_recv().is_ok() {}
				self.empty_callbacks = 0;
				return;
			}
			if self.current_epoch != epoch || self.cursor == self.current.len() {
				self.current.clear();
				self.cursor = 0;
			}
			if self.current.is_empty() {
				match self.rx.try_recv() {
					Ok(next) => {
						if next.epoch != epoch
							|| self.state.speaker_epoch.load(Ordering::Acquire) != epoch
						{
							continue;
						}
						self.current = next.samples;
						self.cursor = 0;
						self.current_epoch = next.epoch;
						self.empty_callbacks = 0;
					},
					Err(TryRecvError::Empty) => break,
					Err(TryRecvError::Disconnected) => {
						self.empty_callbacks += 1;
						if self.empty_callbacks >= self.drain_callbacks {
							self.state.mark_drained();
						}
						break;
					},
				}
			}

			let count = (self.current.len() - self.cursor).min(output.len() - output_offset);
			let source = &self.current[self.cursor..self.cursor + count];
			let destination = &mut output[output_offset..output_offset + count];
			if gain == 1.0 {
				destination.copy_from_slice(source);
			} else {
				for (destination, source) in destination.iter_mut().zip(source) {
					*destination = *source * gain;
				}
			}
			self.cursor += count;
			output_offset += count;
		}
	}
}

/// Running default-microphone capture delivering low-latency mono `f32`
/// chunks to its callback. Wraps the platform device so N-API callers never
/// see backend types.
pub struct CaptureStream {
	device: Option<CaptureDevice>,
}

impl CaptureStream {
	/// Open the default microphone at the requested sample rate. `on_audio`
	/// receives each chunk with the instant its first sample was captured and
	/// runs on the realtime audio thread — it must not block.
	pub fn start<C>(sample_rate: u32, mut on_audio: C) -> VoiceResult<Self>
	where
		C: FnMut(&[f32], Instant) + Send + 'static,
	{
		let sample_rate = audio_sample_rate(sample_rate)?;
		let config = DeviceConfig { sample_rate, period_ms: CAPTURE_PERIOD_MS };
		let device = CaptureDevice::start(
			config,
			Box::new(move |samples, captured_at| {
				if !samples.is_empty() {
					on_audio(samples, captured_at);
				}
			}),
		)
		.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		Ok(Self { device: Some(device) })
	}

	/// Stop capture immediately and release the microphone.
	pub fn stop(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
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

	// Base three-period assumption (`PULSE_BACKLOG_PERIODS` on Linux; fixed
	// for other backends) plus the one callback of teardown-race margin
	// (`PLAYBACK_DRAIN_MARGIN_CALLBACKS`) — what every backend uses for a
	// period-sized local target.
	const LOCAL_DRAIN_CALLBACKS: usize = 3 + PLAYBACK_DRAIN_MARGIN_CALLBACKS;

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = Arc::new(PlaybackState::new());
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		tx.send(PlaybackChunk { samples: vec![1.0, -1.0], epoch: 0 })
			.expect("receiver is live");
		tx.send(PlaybackChunk { samples: vec![0.5, -0.5], epoch: 0 })
			.expect("receiver is live");
		drop(tx);
		let mut render = PlaybackRender::new(rx, Arc::clone(&state), LOCAL_DRAIN_CALLBACKS, None);
		let mut output = [9.0; 5];

		render.write(&mut output);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while render.empty_callbacks < LOCAL_DRAIN_CALLBACKS {
			silence.fill(1.0);
			render.write(&mut silence);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				state.drained.load(Ordering::Acquire),
				render.empty_callbacks >= LOCAL_DRAIN_CALLBACKS
			);
		}
	}

	/// Regression guard: a widened playback backlog (remote `PULSE_SERVER` or
	/// `PULSE_LATENCY_MSEC`) must not be declared drained after only the
	/// local three-period margin — queued audio would still be flushing to
	/// the speaker and `AudioPlayback.end()` would clip it. Draining must
	/// wait out the full widened `drain_callbacks` count.
	#[test]
	fn widened_backlog_is_not_drained_within_local_margin() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded::<PlaybackChunk>();
		drop(tx);
		let widened_drain_callbacks = LOCAL_DRAIN_CALLBACKS * 4;
		let mut render = PlaybackRender::new(rx, Arc::clone(&state), widened_drain_callbacks, None);
		let mut output = [0.0; 2];

		for _ in 0..LOCAL_DRAIN_CALLBACKS {
			render.write(&mut output);
		}
		assert!(
			!state.drained.load(Ordering::Acquire),
			"drained after only the local margin despite a widened backlog"
		);

		while render.empty_callbacks < widened_drain_callbacks {
			render.write(&mut output);
		}
		assert!(state.drained.load(Ordering::Acquire));
	}

	#[test]
	fn suppression_discards_partial_output_and_rejects_audio_until_resumed() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded();
		let writer = PlaybackWriter { tx, flush_rx: None, state: Arc::clone(&state) };
		writer.write(&[1.0, 0.5, 0.25]).unwrap();
		let stream = PlaybackStream {
			device:   None,
			writer:   None,
			state:    Arc::clone(&state),
			flush_rx: rx.clone(),
		};
		let mut render = PlaybackRender::new(rx, Arc::clone(&state), LOCAL_DRAIN_CALLBACKS, None);
		let mut first = [0.0; 1];
		render.write(&mut first);
		assert_eq!(first, [1.0]);

		stream.set_suppressed(true).unwrap();
		writer.write(&[0.125]).unwrap();
		stream.set_suppressed(false).unwrap();
		let mut resumed = [9.0; 2];
		render.write(&mut resumed);
		assert_eq!(resumed, [0.0; 2]);
		writer.write(&[0.75, 0.5]).unwrap();
		let mut new_audio = [0.0; 2];
		render.write(&mut new_audio);
		assert_eq!(new_audio, [0.75, 0.5]);
	}

	#[test]
	fn live_playback_overflow_discards_stale_chunks_instead_of_growing_lag() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::bounded(LIVE_PLAYBACK_QUEUE_CHUNKS);
		let writer = PlaybackWriter { tx, flush_rx: Some(rx.clone()), state: Arc::clone(&state) };
		for index in 0..LIVE_PLAYBACK_QUEUE_CHUNKS + 4 {
			writer.write(&[index as f32]).unwrap();
		}
		let mut render = PlaybackRender::new(rx, Arc::clone(&state), LOCAL_DRAIN_CALLBACKS, None);
		let mut output = [9.0; 1];
		render.write(&mut output);
		assert_eq!(output, [(LIVE_PLAYBACK_QUEUE_CHUNKS) as f32]);
		let mut next = [9.0; 1];
		render.write(&mut next);
		assert_eq!(next, [(LIVE_PLAYBACK_QUEUE_CHUNKS + 1) as f32]);
	}
	/// Echo cancellation aligns microphone capture against this tap, so it
	/// must see the post-gain samples the device received, including the
	/// silence written while nothing is queued, at the device's timestamps.
	#[test]
	fn reference_tap_receives_rendered_buffers_with_presentation_time() {
		let state = Arc::new(PlaybackState::new());
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		let writer = PlaybackWriter { tx, flush_rx: None, state: Arc::clone(&state) };
		let (reference_tx, reference_rx) = flume::unbounded();
		let mut render = PlaybackRender::new(
			rx,
			Arc::clone(&state),
			LOCAL_DRAIN_CALLBACKS,
			Some(Box::new(move |samples: &[f32], at: Instant| {
				reference_tx
					.send((samples.to_vec(), at))
					.expect("reference receiver is live");
			})),
		);
		writer.write(&[1.0, -1.0, 0.5]).unwrap();
		let first_at = Instant::now();
		let second_at = first_at + Duration::from_millis(20);

		render.fill(&mut [9.0; 4], first_at);
		render.fill(&mut [9.0; 2], second_at);

		assert_eq!(reference_rx.try_iter().collect::<Vec<_>>(), [
			(vec![0.5, -0.5, 0.25, 0.0], first_at),
			(vec![0.0, 0.0], second_at),
		]);
	}

	#[test]
	fn live_playback_queue_is_bounded_without_blocking_the_producer() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::bounded(LIVE_PLAYBACK_QUEUE_CHUNKS);
		let writer = PlaybackWriter { tx, flush_rx: Some(rx.clone()), state: Arc::clone(&state) };
		for index in 0..LIVE_PLAYBACK_QUEUE_CHUNKS + 1 {
			writer.write(&[index as f32]).unwrap();
		}
		assert_eq!(rx.len(), 1);
		assert_eq!(rx.try_recv().unwrap().samples, [LIVE_PLAYBACK_QUEUE_CHUNKS as f32]);
	}

	#[test]
	fn regular_playback_retains_every_queued_chunk() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded();
		let writer = PlaybackWriter { tx, flush_rx: None, state: Arc::clone(&state) };
		for index in 0..LIVE_PLAYBACK_QUEUE_CHUNKS + 1 {
			writer.write(&[index as f32]).unwrap();
		}
		let mut render = PlaybackRender::new(rx, Arc::clone(&state), LOCAL_DRAIN_CALLBACKS, None);
		let mut output = [0.0; LIVE_PLAYBACK_QUEUE_CHUNKS + 1];
		render.write(&mut output);
		assert_eq!(output, std::array::from_fn(|index| index as f32));
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let mut stream = PlaybackStream::start(16_000).expect("default playback device starts");
		stream.stop().expect("default playback device stops");
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut stream = CaptureStream::start(16_000, move |_samples, _captured_at| {
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
