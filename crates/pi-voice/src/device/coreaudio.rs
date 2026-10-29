//! macOS default-device audio backend using `AudioToolbox` Audio Queues.

use std::{
	ffi::c_void,
	ptr, slice,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use super::{CaptureSink, DeviceConfig, PlaybackFill};
use crate::VoiceResult;

const BUFFER_COUNT: usize = 3;
const LINEAR_PCM: u32 = 0x6c70_636d;
const FORMAT_FLAGS: u32 = 0x9;
const SAMPLE_TIME_VALID: u32 = 1 << 0;
const HOST_TIME_VALID: u32 = 1 << 1;

type AudioQueueRef = *mut AudioQueueOpaque;
type AudioQueueTimelineRef = *mut AudioQueueTimelineOpaque;
type AudioStreamPacketDescription = c_void;

#[repr(C)]
struct AudioQueueOpaque {
	_private: [u8; 0],
}

#[repr(C)]
struct AudioQueueTimelineOpaque {
	_private: [u8; 0],
}

struct QueueHandle(AudioQueueRef);

// SAFETY: AudioQueue control functions explicitly support calls from arbitrary
// threads.
unsafe impl Send for QueueHandle {}

impl QueueHandle {
	fn stop_and_dispose(self) -> VoiceResult<()> {
		// SAFETY: This handle owns a live queue; an immediate stop waits for
		// queue activity.
		let stop_status = unsafe { AudioQueueStop(self.0, 1) };
		// SAFETY: The synchronous stop completed, and this handle exclusively
		// owns the queue.
		let dispose_status = unsafe { AudioQueueDispose(self.0, 1) };
		if stop_status != 0 {
			return Err(format!("CoreAudio queue stop failed (OSStatus {stop_status})"));
		}
		if dispose_status != 0 {
			return Err(format!("CoreAudio queue dispose failed (OSStatus {dispose_status})"));
		}
		Ok(())
	}
}

#[repr(C)]
#[allow(non_snake_case, reason = "fields must match the CoreAudio C ABI")]
struct AudioStreamBasicDescription {
	mSampleRate:       f64,
	mFormatID:         u32,
	mFormatFlags:      u32,
	mBytesPerPacket:   u32,
	mFramesPerPacket:  u32,
	mBytesPerFrame:    u32,
	mChannelsPerFrame: u32,
	mBitsPerChannel:   u32,
	mReserved:         u32,
}

#[repr(C)]
#[allow(non_snake_case, reason = "fields must match the AudioQueue C ABI")]
struct AudioQueueBuffer {
	mAudioDataBytesCapacity:    u32,
	mAudioData:                 *mut c_void,
	mAudioDataByteSize:         u32,
	mUserData:                  *mut c_void,
	mPacketDescriptionCapacity: u32,
	mPacketDescriptions:        *mut c_void,
	mPacketDescriptionCount:    u32,
}

#[repr(C)]
#[derive(Default)]
#[allow(non_snake_case, reason = "fields must match the CoreAudio C ABI")]
struct SMPTETime {
	mSubframes:       i16,
	mSubframeDivisor: i16,
	mCounter:         u32,
	mType:            u32,
	mFlags:           u32,
	mHours:           i16,
	mMinutes:         i16,
	mSeconds:         i16,
	mFrames:          i16,
}

#[repr(C)]
#[derive(Default)]
#[allow(non_snake_case, reason = "fields must match the CoreAudio C ABI")]
struct AudioTimeStamp {
	mSampleTime:    f64,
	mHostTime:      u64,
	mRateScalar:    f64,
	mWordClockTime: u64,
	mSMPTETime:     SMPTETime,
	mFlags:         u32,
	mReserved:      u32,
}

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
	fn AudioQueueNewOutput(
		format: *const AudioStreamBasicDescription,
		callback: unsafe extern "C" fn(*mut c_void, AudioQueueRef, *mut AudioQueueBuffer),
		user_data: *mut c_void,
		callback_run_loop: *const c_void,
		callback_run_loop_mode: *const c_void,
		flags: u32,
		queue: *mut AudioQueueRef,
	) -> i32;
	fn AudioQueueNewInput(
		format: *const AudioStreamBasicDescription,
		callback: unsafe extern "C" fn(
			*mut c_void,
			AudioQueueRef,
			*mut AudioQueueBuffer,
			*const AudioTimeStamp,
			u32,
			*const AudioStreamPacketDescription,
		),
		user_data: *mut c_void,
		callback_run_loop: *const c_void,
		callback_run_loop_mode: *const c_void,
		flags: u32,
		queue: *mut AudioQueueRef,
	) -> i32;
	fn AudioQueueAllocateBuffer(
		queue: AudioQueueRef,
		buffer_byte_size: u32,
		buffer: *mut *mut AudioQueueBuffer,
	) -> i32;
	fn AudioQueueEnqueueBuffer(
		queue: AudioQueueRef,
		buffer: *mut AudioQueueBuffer,
		packet_description_count: u32,
		packet_descriptions: *const AudioStreamPacketDescription,
	) -> i32;
	fn AudioQueueStart(queue: AudioQueueRef, start_time: *const AudioTimeStamp) -> i32;
	fn AudioQueueStop(queue: AudioQueueRef, immediate: u8) -> i32;
	fn AudioQueueDispose(queue: AudioQueueRef, immediate: u8) -> i32;
	fn AudioQueueCreateTimeline(queue: AudioQueueRef, timeline: *mut AudioQueueTimelineRef) -> i32;
	fn AudioQueueGetCurrentTime(
		queue: AudioQueueRef,
		timeline: AudioQueueTimelineRef,
		time_stamp: *mut AudioTimeStamp,
		discontinuity: *mut u8,
	) -> i32;
}

unsafe extern "C" {
	fn pthread_self() -> usize;
	fn mach_absolute_time() -> u64;
	fn mach_timebase_info(info: *mut HostClock) -> i32;
}

struct Context<C> {
	callback:        C,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
}

fn stream_format(sample_rate: u32) -> AudioStreamBasicDescription {
	AudioStreamBasicDescription {
		mSampleRate:       f64::from(sample_rate),
		mFormatID:         LINEAR_PCM,
		mFormatFlags:      FORMAT_FLAGS,
		mBytesPerPacket:   size_of::<f32>() as u32,
		mFramesPerPacket:  1,
		mBytesPerFrame:    size_of::<f32>() as u32,
		mChannelsPerFrame: 1,
		mBitsPerChannel:   32,
		mReserved:         0,
	}
}

fn buffer_size(config: DeviceConfig) -> VoiceResult<u32> {
	config
		.period_samples()
		.checked_mul(size_of::<f32>())
		.and_then(|bytes| u32::try_from(bytes).ok())
		.ok_or_else(|| "CoreAudio period buffer is too large".to_owned())
}

fn dispose_failed_start(queue: AudioQueueRef, operation: &str, status: i32) -> String {
	if !queue.is_null() {
		// SAFETY: `queue` was returned by AudioQueueNewInput/Output and has not
		// been disposed.
		unsafe { AudioQueueDispose(queue, 1) };
	}
	format!("CoreAudio {operation} failed (OSStatus {status})")
}

/// Shared queue-callback body: marks the callback thread, runs `deliver` on
/// the buffer unless stopped, and re-enqueues it while still running.
///
/// # Safety
/// `user_data` must be the live `Context<C>` the queue was created with, and
/// `queue`/`buffer` the pointers `AudioQueue` passed to the callback.
unsafe fn on_buffer<C>(
	user_data: *mut c_void,
	queue: AudioQueueRef,
	buffer: *mut AudioQueueBuffer,
	deliver: impl FnOnce(&mut C, &mut AudioQueueBuffer),
) {
	if user_data.is_null() || queue.is_null() || buffer.is_null() {
		return;
	}
	let context = user_data.cast::<Context<C>>();
	// SAFETY: AudioQueue passes the live context pointer supplied when the queue
	// was created.
	unsafe {
		(*context)
			.callback_thread
			.store(pthread_self(), Ordering::Release);
	};
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if unsafe { (*context).stopped.load(Ordering::Acquire) } {
		// SAFETY: The context remains live until synchronous queue disposal
		// completes.
		unsafe { (*context).callback_thread.store(0, Ordering::Release) };
		return;
	}
	// SAFETY: AudioQueue passes one of its allocated buffers exclusively to this
	// callback.
	let buffer = unsafe { &mut *buffer };
	// SAFETY: AudioQueue serializes callbacks, so only this callback borrows the
	// `callback` field.
	deliver(unsafe { &mut (*context).callback }, buffer);
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if !unsafe { (*context).stopped.load(Ordering::Acquire) } {
		// SAFETY: The queue and buffer belong to this callback and remain live
		// while it returns.
		let _ = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
	}
	// SAFETY: The context remains live until synchronous queue disposal
	// completes.
	unsafe { (*context).callback_thread.store(0, Ordering::Release) };
}

/// Tick rate of `mach_absolute_time`, the clock behind
/// `AudioTimeStamp::mHostTime`. Layout matches `mach_timebase_info_data_t`.
#[repr(C)]
#[derive(Clone, Copy)]
struct HostClock {
	numer: u32,
	denom: u32,
}

impl HostClock {
	fn new() -> VoiceResult<Self> {
		let mut clock = Self { numer: 0, denom: 0 };
		// SAFETY: `clock` matches `mach_timebase_info_data_t` and is writable.
		let status = unsafe { mach_timebase_info(&mut clock) };
		if status != 0 || clock.numer == 0 || clock.denom == 0 {
			return Err(format!("mach timebase query failed (kern_return_t {status})"));
		}
		Ok(clock)
	}

	fn ticks_to_duration(self, ticks: u64) -> Duration {
		let nanos = u128::from(ticks) * u128::from(self.numer) / u128::from(self.denom);
		Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
	}

	/// Map a host time to an `Instant` by reading both clocks back to back.
	fn instant(self, host_time: u64) -> Instant {
		// SAFETY: `mach_absolute_time` has no preconditions.
		let host_now = unsafe { mach_absolute_time() };
		let now = Instant::now();
		let shifted = if host_time <= host_now {
			now.checked_sub(self.ticks_to_duration(host_now - host_time))
		} else {
			now.checked_add(self.ticks_to_duration(host_time - host_now))
		};
		shifted.unwrap_or(now)
	}
}

/// `at` moved by `seconds` (negative is earlier); an unrepresentable shift
/// leaves `at` unchanged rather than panicking on the audio thread.
fn shift(at: Instant, seconds: f64) -> Instant {
	let shifted = if seconds >= 0.0 {
		Duration::try_from_secs_f64(seconds)
			.ok()
			.and_then(|delta| at.checked_add(delta))
	} else {
		Duration::try_from_secs_f64(-seconds)
			.ok()
			.and_then(|delta| at.checked_sub(delta))
	};
	shifted.unwrap_or(at)
}

/// A frame on a queue's sample timeline and the `Instant` it corresponds to.
#[derive(Clone, Copy)]
struct QueueTime {
	frame: f64,
	at:    Instant,
}

impl QueueTime {
	fn instant_of(self, frame: f64, sample_rate: f64) -> Instant {
		shift(self.at, (frame - self.frame) / sample_rate)
	}
}

/// Read the queue's current position, counted in frames at the queue's own
/// sample rate from where the queue started, and whether `timeline` reports a
/// discontinuity since its last read. `None` while the queue is not running.
fn current_queue_time(
	queue: AudioQueueRef,
	timeline: AudioQueueTimelineRef,
	clock: HostClock,
) -> Option<(QueueTime, bool)> {
	let mut stamp = AudioTimeStamp::default();
	let mut discontinuity = 0;
	// SAFETY: `queue` is live, `timeline` is null or belongs to `queue`, and
	// both out-pointers reference writable locals.
	let status =
		unsafe { AudioQueueGetCurrentTime(queue, timeline, &mut stamp, &mut discontinuity) };
	if status != 0 || stamp.mFlags & SAMPLE_TIME_VALID == 0 {
		return None;
	}
	// Without a host time the stamp describes the moment of this call.
	let at = if stamp.mFlags & HOST_TIME_VALID == 0 {
		Instant::now()
	} else {
		clock.instant(stamp.mHostTime)
	};
	Some((QueueTime { frame: stamp.mSampleTime, at }, discontinuity != 0))
}

/// Output queue state: the fill callback plus the queue-timeline bookkeeping
/// that stamps each buffer with when its first frame plays.
///
/// Every estimate errs early, never late: an early stamp only lengthens the
/// echo delay AEC absorbs, while a late one puts echo ahead of its reference.
/// For the same reason the device's own presentation latency, which
/// `AudioQueue` does not report, is left out rather than guessed.
struct Playback {
	fill:        PlaybackFill,
	clock:       HostClock,
	sample_rate: f64,
	/// Null when creation failed; discontinuities then go unreported.
	timeline:    AudioQueueTimelineRef,
	/// Queue frame where the next enqueued buffer starts. Buffers play back to
	/// back from frame 0, the start of the first primed buffer.
	next_frame:  f64,
	/// Frames queued ahead of the play position at the last regular callback.
	lead:        Option<f64>,
	/// Latest queue frame with a known `Instant`, extrapolated whenever the
	/// queue clock cannot be read.
	anchor:      Option<QueueTime>,
}

// SAFETY: `timeline` is only passed to AudioQueue functions, which accept calls
// from any thread, and is disposed together with its queue.
unsafe impl Send for Playback {}

impl Playback {
	fn new(fill: PlaybackFill, config: DeviceConfig, clock: HostClock) -> Self {
		Self {
			fill,
			clock,
			sample_rate: f64::from(config.sample_rate),
			timeline: ptr::null_mut(),
			next_frame: 0.0,
			lead: None,
			anchor: None,
		}
	}

	/// Create the discontinuity timeline before the queue starts.
	fn attach(&mut self, queue: AudioQueueRef) {
		let mut timeline = ptr::null_mut();
		// SAFETY: `queue` is live and `timeline` is writable storage for the
		// result.
		if unsafe { AudioQueueCreateTimeline(queue, &mut timeline) } == 0 {
			self.timeline = timeline;
		}
	}

	/// Fill `buffer` to capacity and mark it full for the queue. `queue` is
	/// `None` while priming, before the queue clock runs.
	fn render(&mut self, queue: Option<AudioQueueRef>, buffer: &mut AudioQueueBuffer) {
		let sample_count = buffer.mAudioDataBytesCapacity as usize / size_of::<f32>();
		// SAFETY: AudioQueue allocated `mAudioData` with the reported capacity
		// for linear PCM data.
		let samples =
			unsafe { slice::from_raw_parts_mut(buffer.mAudioData.cast::<f32>(), sample_count) };
		let presented_at = self.presentation_time(queue);
		(self.fill)(samples, presented_at);
		self.next_frame += sample_count as f64;
		buffer.mAudioDataByteSize = buffer.mAudioDataBytesCapacity;
	}

	fn presentation_time(&mut self, queue: Option<AudioQueueRef>) -> Instant {
		if let Some((now, discontinuity)) =
			queue.and_then(|queue| current_queue_time(queue, self.timeline, self.clock))
		{
			if now.frame >= self.next_frame {
				// Underrun: the queue clock passed everything enqueued, so this
				// buffer starts as soon as the queue can schedule it.
				self.next_frame = now.frame;
			} else if discontinuity {
				// The timeline jumped (device or rate change), losing where the
				// enqueued buffers sit on it. Assume the queue still holds what it
				// held at the last regular callback, never moving later.
				if let Some(lead) = self.lead {
					self.next_frame = self.next_frame.min(now.frame + lead);
				}
			} else {
				self.lead = Some(self.next_frame - now.frame);
			}
			self.anchor = Some(now);
		}
		// Before the queue starts its clock does not run, so priming stamps from
		// now plus the frames already primed ahead; failed reads later on
		// extrapolate from the last reading.
		let anchor = *self
			.anchor
			.get_or_insert_with(|| QueueTime { frame: self.next_frame, at: Instant::now() });
		anchor.instant_of(self.next_frame, self.sample_rate)
	}
}

/// Input queue state: the sink plus what stamps each chunk with when its first
/// frame was captured.
struct Capture {
	sink:        CaptureSink,
	clock:       HostClock,
	sample_rate: f64,
}

impl Capture {
	fn deliver(
		&mut self,
		queue: AudioQueueRef,
		buffer: &AudioQueueBuffer,
		start_time: *const AudioTimeStamp,
	) {
		let byte_size = buffer.mAudioDataByteSize as usize;
		if byte_size == 0 || !byte_size.is_multiple_of(size_of::<f32>()) {
			return;
		}
		// SAFETY: AudioQueue filled `mAudioDataByteSize` bytes within this
		// allocated buffer.
		let samples = unsafe {
			slice::from_raw_parts(buffer.mAudioData.cast::<f32>(), byte_size / size_of::<f32>())
		};
		let captured_at = self.capture_time(queue, start_time, samples.len());
		(self.sink)(samples, captured_at);
	}

	/// Capture time of the chunk's first frame from the timestamp `AudioQueue`
	/// attaches to the buffer. Device input latency is not reported by the
	/// queue, so stamps err late, which like the playback side only lengthens
	/// the echo delay.
	fn capture_time(
		&self,
		queue: AudioQueueRef,
		start_time: *const AudioTimeStamp,
		frames: usize,
	) -> Instant {
		// SAFETY: AudioQueue passes null or a timestamp valid for this callback.
		if let Some(stamp) = unsafe { start_time.as_ref() } {
			if stamp.mFlags & HOST_TIME_VALID != 0 {
				return self.clock.instant(stamp.mHostTime);
			}
			if stamp.mFlags & SAMPLE_TIME_VALID != 0
				&& let Some((now, _)) = current_queue_time(queue, ptr::null_mut(), self.clock)
			{
				return now.instant_of(stamp.mSampleTime, self.sample_rate);
			}
		}
		// No usable timestamp: the newest frame arrived by now, so the first one
		// is at least the chunk's duration old.
		shift(Instant::now(), -(frames as f64 / self.sample_rate))
	}
}

unsafe extern "C" fn playback_callback(
	user_data: *mut c_void,
	queue: AudioQueueRef,
	buffer: *mut AudioQueueBuffer,
) {
	// SAFETY: The queue was created with a `Context<Playback>`.
	unsafe {
		on_buffer::<Playback>(user_data, queue, buffer, |playback, buffer| {
			playback.render(Some(queue), buffer);
		});
	};
}

unsafe extern "C" fn capture_callback(
	user_data: *mut c_void,
	queue: AudioQueueRef,
	buffer: *mut AudioQueueBuffer,
	start_time: *const AudioTimeStamp,
	_packet_count: u32,
	_packet_descriptions: *const AudioStreamPacketDescription,
) {
	// SAFETY: The queue was created with a `Context<Capture>`.
	unsafe {
		on_buffer::<Capture>(user_data, queue, buffer, |capture, buffer| {
			capture.deliver(queue, buffer, start_time);
		});
	};
}

/// Running `CoreAudio` default-device queue for either direction.
pub struct Device {
	queue:           Option<QueueHandle>,
	/// The type-erased `Context<C>` the queue callbacks point into.
	context:         Option<Box<dyn Send>>,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
	direction:       &'static str,
}

// SAFETY: AudioQueue control functions may be called from any thread, and the
// callback is `Send`.
unsafe impl Send for Device {}

impl Device {
	/// Open and start the default speaker queue.
	pub fn start_playback(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		Self::start(
			config,
			Playback::new(fill, config, HostClock::new()?),
			"playback",
			|format, user_data, queue| {
				// SAFETY: All pointers are valid for the call; the boxed context
				// outlives the queue.
				unsafe {
					AudioQueueNewOutput(
						format,
						playback_callback,
						user_data,
						ptr::null(),
						ptr::null(),
						0,
						queue,
					)
				}
			},
			Playback::attach,
			// Output queues start only with primed buffers.
			|playback, buffer| playback.render(None, buffer),
		)
	}

	/// Open and start the default microphone queue.
	pub fn start_capture(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		let capture =
			Capture { sink, clock: HostClock::new()?, sample_rate: f64::from(config.sample_rate) };
		Self::start(
			config,
			capture,
			"capture",
			|format, user_data, queue| {
				// SAFETY: All pointers are valid for the call; the boxed context
				// outlives the queue.
				unsafe {
					AudioQueueNewInput(
						format,
						capture_callback,
						user_data,
						ptr::null(),
						ptr::null(),
						0,
						queue,
					)
				}
			},
			|_, _| {},
			|_, _| {},
		)
	}

	fn start<C: Send + 'static>(
		config: DeviceConfig,
		callback: C,
		direction: &'static str,
		new_queue: impl FnOnce(*const AudioStreamBasicDescription, *mut c_void, *mut AudioQueueRef) -> i32,
		attach: impl FnOnce(&mut C, AudioQueueRef),
		mut prime: impl FnMut(&mut C, &mut AudioQueueBuffer),
	) -> VoiceResult<Self> {
		let byte_size = buffer_size(config)?;
		let format = stream_format(config.sample_rate);
		let stopped = Arc::new(AtomicBool::new(false));
		let callback_thread = Arc::new(AtomicUsize::new(0));
		let mut context = Box::new(Context {
			callback,
			stopped: Arc::clone(&stopped),
			callback_thread: Arc::clone(&callback_thread),
		});
		let user_data = ptr::from_mut(&mut *context).cast::<c_void>();
		let mut queue = ptr::null_mut();
		let status = new_queue(&format, user_data, &mut queue);
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue creation", status));
		}
		attach(&mut context.callback, queue);

		for _ in 0..BUFFER_COUNT {
			let mut buffer = ptr::null_mut();
			// SAFETY: `queue` is live and `buffer` points to writable storage for
			// the result.
			let status = unsafe { AudioQueueAllocateBuffer(queue, byte_size, &mut buffer) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer allocation", status));
			}
			// SAFETY: AudioQueue returned a valid buffer with at least `byte_size`
			// bytes, not yet shared with any callback.
			prime(&mut context.callback, unsafe { &mut *buffer });
			// SAFETY: `queue` and `buffer` are live, and PCM requires no packet
			// descriptions.
			let status = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer enqueue", status));
			}
		}

		// SAFETY: `queue` is live and null requests immediate start.
		let status = unsafe { AudioQueueStart(queue, ptr::null()) };
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue start", status));
		}
		Ok(Self {
			queue: Some(QueueHandle(queue)),
			context: Some(context),
			stopped,
			callback_thread,
			direction,
		})
	}

	/// Stop the stream and dispose the queue, handing off teardown from its
	/// callback thread.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.stopped.store(true, Ordering::Release);
		let Some(queue) = self.queue.take() else {
			return Ok(());
		};
		let Some(context) = self.context.take() else {
			self.queue = Some(queue);
			return Err(format!("CoreAudio {} queue lost its callback context", self.direction));
		};
		// SAFETY: `pthread_self` returns the stable identifier for the calling
		// thread.
		let current_thread = unsafe { pthread_self() };
		if current_thread != 0 && self.callback_thread.load(Ordering::Acquire) == current_thread {
			let stopped = Arc::clone(&self.stopped);
			drop(std::thread::spawn(move || {
				stopped.store(true, Ordering::Release);
				let _ = queue.stop_and_dispose();
				drop(context);
			}));
			return Ok(());
		}
		let result = queue.stop_and_dispose();
		drop(context);
		result
	}
}

impl Drop for Device {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}
