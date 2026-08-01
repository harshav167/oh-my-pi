//! Microphone capture lane for the native live peer.
//!
//! Owns the encoder task and its control channel. The task holds a
//! `Weak<LivePeerCore>` and reads the shared capture ring, mute flag, and audio
//! processor directly: this is a child module of `live`, so it reaches the
//! parent's private state without widening any visibility.

use std::sync::{Arc, Weak, atomic::Ordering};

use bytes::Bytes;
use opus::{Application, Channels, Encoder};
use parking_lot::Mutex;
use tokio::sync::Notify;
use webrtc::{
	media::Sample, track::track_local::track_local_static_sample::TrackLocalStaticSample,
};

use super::{
	AUDIO_SAMPLE_RATE, CAPTURE_STALL_TIMEOUT, LivePeerCore, MAX_ENCODED_OPUS_BYTES,
	OPUS_FRAME_DURATION, OPUS_PACKET_LOSS_PERC,
	framer::{CaptureQueue, DSP_BLOCK_SAMPLES, FrameAssembler, OPUS_FRAME_SAMPLES},
};

/// Control messages for the encoder task; audio travels through the shared
/// [`CaptureQueue`] ring instead.
pub(super) enum InputCommand {
	Muted(bool),
	/// Release retained startup audio and begin transmitting.
	Activate,
	Close,
}

/// Root-mean-square of one capture block, used only for the input meter.
fn block_level(block: &[f32]) -> f64 {
	if block.is_empty() {
		return 0.0;
	}
	let mut sum_squares = 0.0f64;
	for &sample in block {
		let sample = f64::from(sample);
		sum_squares = sample.mul_add(sample, sum_squares);
	}
	(sum_squares / block.len() as f64).sqrt()
}

/// Encode capture audio strictly on the microphone's own clock.
///
/// A late capture callback delays the next packet; it never produces one. The
/// only silence transmitted is silence the user muted.
pub(super) async fn run_input_audio(
	track: Arc<TrackLocalStaticSample>,
	input_rx: flume::Receiver<InputCommand>,
	queue: Arc<Mutex<CaptureQueue>>,
	wake: Arc<Notify>,
	core: Weak<LivePeerCore>,
) {
	let mut encoder = match Encoder::new(AUDIO_SAMPLE_RATE, Channels::Mono, Application::Voip) {
		Ok(encoder) => encoder,
		Err(error) => {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Failed to initialize the live Opus encoder: {error}"));
			}
			return;
		},
	};
	if let Err(error) = encoder
		.set_inband_fec(true)
		.and_then(|()| encoder.set_packet_loss_perc(OPUS_PACKET_LOSS_PERC))
	{
		if let Some(core) = core.upgrade() {
			core.report_failure(format!("Failed to configure the live Opus encoder: {error}"));
		}
		return;
	}

	let mut muted = false;
	let mut stalled = false;
	let mut assembler = FrameAssembler::default();
	let mut block = [0.0f32; DSP_BLOCK_SAMPLES];
	let mut frame = [0.0f32; OPUS_FRAME_SAMPLES];
	let mut encoded = [0u8; MAX_ENCODED_OPUS_BYTES];

	loop {
		let woken = tokio::select! {
			biased;
			command = input_rx.recv_async() => {
				match command {
					Ok(InputCommand::Muted(next_muted)) => {
						muted = next_muted;
						if muted {
							// Mute is a privacy control: nothing already captured
							// may still go out, including a half-assembled packet.
							queue.lock().silence_queued();
							assembler.silence_pending();
						}
						stalled = false;
						continue;
					},
					Ok(InputCommand::Activate) => {
						queue.lock().activate();
						stalled = false;
						true
					},
					Ok(InputCommand::Close) | Err(_) => break,
				}
			},
			() = wake.notified() => true,
			() = tokio::time::sleep(CAPTURE_STALL_TIMEOUT) => false,
		};

		let Some(core) = core.upgrade() else {
			return;
		};
		if !woken {
			// A silent device is only a problem while it should be delivering
			// audio. This is diagnostic, never terminal: media stays connected.
			if queue.lock().active() && !muted && !stalled {
				stalled = true;
				core.report_capture_stalled();
			}
			continue;
		}
		stalled = false;

		// The startup-release flush can drain tens of seconds of retained audio in
		// one wake. Commands only reach the outer `select!`, so without polling
		// here a mute issued mid-flush is unread while already-captured speech is
		// encoded and sent -- the exact thing the privacy contract above forbids.
		let mut closing = false;
		loop {
			while let Ok(command) = input_rx.try_recv() {
				match command {
					InputCommand::Muted(next_muted) => {
						muted = next_muted;
						if muted {
							queue.lock().silence_queued();
							assembler.silence_pending();
						}
					},
					InputCommand::Activate => queue.lock().activate(),
					InputCommand::Close => closing = true,
				}
			}
			if closing {
				break;
			}
			let (has_block, dropped, max_queued) = {
				let mut queue = queue.lock();
				(queue.next_block(&mut block), queue.dropped_samples(), queue.max_queued_samples())
			};
			core
				.counters
				.input_dropped_samples
				.store(dropped, Ordering::Relaxed);
			core
				.counters
				.max_queued_input_samples
				.store(max_queued, Ordering::Relaxed);
			if !has_block {
				break;
			}
			if let Some(reason) = core.processing.process_capture(&mut block) {
				core.report_diagnostic(&reason);
			}
			if muted {
				// AGC and noise suppression carry internal state and can emit
				// non-zero samples from a silent input, so mute is enforced on
				// the post-DSP block that actually reaches the encoder.
				block.fill(0.0);
			}
			core.report_input_level(if muted { 0.0 } else { block_level(&block) });
			assembler.push_processed(&block);

			while assembler.next_frame(&mut frame) {
				let encoded_len = match encoder.encode_float(&frame, &mut encoded) {
					Ok(encoded_len) => encoded_len,
					Err(error) => {
						core.report_failure(format!("Failed to encode live microphone audio: {error}"));
						return;
					},
				};
				if muted {
					core
						.counters
						.input_silence_padded_frames
						.fetch_add(1, Ordering::Relaxed);
				} else {
					core.counters.input_frames.fetch_add(1, Ordering::Relaxed);
				}
				let sample = Sample {
					data: Bytes::copy_from_slice(&encoded[..encoded_len]),
					duration: OPUS_FRAME_DURATION,
					..Default::default()
				};
				if let Err(error) = track.write_sample(&sample).await {
					core.report_failure(format!("Failed to send live microphone audio: {error}"));
					return;
				}
			}
		}
		if closing {
			break;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn opus_encoder_enables_in_band_fec_it_advertises() {
		// The SDP in `live.rs` advertises `useinbandfec=1`; this lane is what must
		// actually back it, or the receiver's FEC recovery silently never fires.
		let mut encoder =
			Encoder::new(AUDIO_SAMPLE_RATE, Channels::Mono, Application::Voip).expect("encoder");

		encoder.set_inband_fec(true).expect("fec is supported");
		encoder
			.set_packet_loss_perc(OPUS_PACKET_LOSS_PERC)
			.expect("loss percentage is supported");

		assert!(
			encoder.get_inband_fec().expect("fec is readable"),
			"advertised useinbandfec=1 must be backed by an enabled encoder"
		);
	}

	#[test]
	fn block_level_is_zero_for_silence_and_unity_for_full_scale() {
		assert!(block_level(&[0.0; 480]).abs() < f64::EPSILON);
		assert!((block_level(&[1.0; 480]) - 1.0).abs() < 1e-9);
		assert!(block_level(&[]).abs() < f64::EPSILON);
	}
}
