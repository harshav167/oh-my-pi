use std::time::{Duration, Instant};

use opus::{Channels, Decoder};
use sonora::config::EchoCanceller;

use super::*;

const OUTPUT_LATENCY: Duration = Duration::from_millis(80);
const INPUT_LATENCY: Duration = Duration::from_millis(30);

/// Runs two seconds of the live worker timeline and returns the decoded
/// capture energy after the first second, with and without the speaker
/// reference. Every 10 ms the speaker tap delivers the block that reaches
/// the speaker `OUTPUT_LATENCY` later, and the microphone delivers the block
/// captured `INPUT_LATENCY` earlier, holding speaker output that reached the
/// microphone `acoustic_delay` samples after it played.
fn echo_energy(acoustic_delay: i64) -> [f32; 2] {
	let mut processors = vec![Processor::new().unwrap(), Processor::new().unwrap()];
	for processor in &mut processors {
		// Isolate echo cancellation from independent noise/gain adaptation.
		processor.apm.apply_config(sonora::Config {
			echo_canceller: Some(EchoCanceller::default()),
			..Default::default()
		});
	}
	// White-noise bursts over pseudo-random 100 ms segments: aperiodic, so a
	// misaligned reference predicts neither the echo nor its envelope.
	let speaker = |sample: i64| {
		if sample < 0 || !mix((sample / 4_800) as u64).is_multiple_of(3) {
			return 0.0;
		}
		((mix(sample as u64) >> 40) as f32 / (1 << 24) as f32).mul_add(0.2, -0.1)
	};
	let capture_lag = samples_in(OUTPUT_LATENCY + INPUT_LATENCY) + acoustic_delay;
	let start = Instant::now() + INPUT_LATENCY;
	let mut packets = [Vec::new(), Vec::new()];

	for block in 0..200_u32 {
		let now = start + Duration::from_millis(10) * block;
		let presented_at = now + OUTPUT_LATENCY;
		let captured_at = now.checked_sub(INPUT_LATENCY).unwrap();
		let played = i64::from(block) * PROCESSING_BLOCK_SAMPLES as i64;
		let mut reference = [0.0; PROCESSING_BLOCK_SAMPLES];
		let mut capture = [0.0; PROCESSING_BLOCK_SAMPLES];
		for (index, (reference, capture)) in reference.iter_mut().zip(&mut capture).enumerate() {
			*reference = speaker(played + index as i64);
			*capture = speaker(played + index as i64 - capture_lag);
		}
		processors[0].render(&reference, presented_at, now).unwrap();
		// Keep delay metadata identical: only consuming reference samples may
		// explain the difference in the decoded capture signal.
		processors[1].render_delay = processors[0].render_delay;
		for (processor, packets) in processors.iter_mut().zip(&mut packets) {
			packets.extend(
				processor
					.capture(&capture, captured_at, now, |_| {})
					.unwrap(),
			);
		}
	}

	let decoded = packets.map(|packets| {
		let mut decoder = Decoder::new(SAMPLE_RATE, Channels::Mono).unwrap();
		let mut audio = Vec::new();
		for packet in packets {
			let mut frame = [0.0; OPUS_FRAME_SAMPLES];
			assert_eq!(
				decoder
					.decode_float(&packet.data, &mut frame, false)
					.unwrap(),
				OPUS_FRAME_SAMPLES
			);
			audio.extend(frame);
		}
		audio
	});
	assert_eq!(decoded[0].len(), decoded[1].len());
	assert!(decoded[0].len() > SAMPLE_RATE as usize);
	decoded.map(|audio| {
		audio[SAMPLE_RATE as usize..]
			.iter()
			.map(|sample| sample * sample)
			.sum::<f32>()
	})
}

/// `SplitMix64` output for `index`: a deterministic stand-in for randomness.
const fn mix(index: u64) -> u64 {
	let mut bits = index.wrapping_mul(0x9e37_79b9_7f4a_7c15);
	bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
	bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
	bits ^ (bits >> 31)
}

fn samples_in(duration: Duration) -> i64 {
	(duration.as_millis() as i64) * i64::from(SAMPLE_RATE) / 1_000
}

#[test]
fn reference_presented_ahead_of_capture_cancels_echo() {
	// Five milliseconds of acoustic path from speaker to microphone.
	let aligned = echo_energy(samples_in(Duration::from_millis(5)));
	assert!(aligned[1] > 1.0, "control capture must contain the echo: {aligned:?}");
	assert!(aligned[0] < aligned[1] * 0.1, "reference/control echo energy: {aligned:?}");

	// The same output reaching the worker 100 ms after its echo was captured
	// cannot be cancelled: the reference has to lead the capture.
	let late = echo_energy(-samples_in(OUTPUT_LATENCY + INPUT_LATENCY + Duration::from_millis(100)));
	let residual = |energy: [f32; 2]| energy[0] / energy[1];
	assert!(residual(late) > 10.0 * residual(aligned), "aligned {aligned:?}, late {late:?}");
}

#[test]
fn echo_delay_adds_capture_age_to_signed_reference_lead() {
	let millis = Duration::from_millis;
	let mut processor = Processor::new().unwrap();
	let first_capture = Instant::now();
	let reference = [0.0; 2 * PROCESSING_BLOCK_SAMPLES];
	let capture_block = |processor: &mut Processor, index: u32, age: Duration| {
		let at = first_capture + millis(10) * index;
		processor
			.capture(&[0.0; PROCESSING_BLOCK_SAMPLES], at, at + age, |_| {})
			.map(|_| processor.apm.stream_delay_ms())
	};

	// The latest reference block reaches the speaker 50 ms after analysis.
	let now = first_capture + millis(30);
	processor.render(&reference, now + millis(40), now).unwrap();
	assert_eq!(capture_block(&mut processor, 0, millis(30)), Ok(80));

	// A reference analyzed after it played offsets the capture age.
	let now = first_capture + millis(90);
	processor
		.render(&reference, now.checked_sub(millis(60)).unwrap(), now)
		.unwrap();
	assert_eq!(capture_block(&mut processor, 1, millis(80)), Ok(30));

	let now = first_capture + millis(100);
	processor
		.render(&reference, now.checked_sub(millis(400)).unwrap(), now)
		.unwrap();
	assert_eq!(capture_block(&mut processor, 2, millis(80)), Ok(0));

	processor.reset_render();
	assert_eq!(capture_block(&mut processor, 3, millis(80)), Ok(80));

	// A combined delay past the deadline is clamped, and the audio encodes.
	let now = first_capture + millis(495);
	processor.render(&reference, now + millis(40), now).unwrap();
	assert_eq!(capture_block(&mut processor, 4, millis(455)), Ok(500));
	let at = first_capture + millis(50);
	assert_eq!(
		processor
			.capture(&[0.0; PROCESSING_BLOCK_SAMPLES], at, at + millis(455), |_| {})
			.map(|packets| packets.len()),
		Ok(1)
	);

	// Capture older than the deadline still cannot be processed.
	let at = first_capture + millis(60);
	assert_eq!(
		processor
			.capture(&[0.0; PROCESSING_BLOCK_SAMPLES], at, at + millis(501), |_| {})
			.map(|packets| packets.len()),
		Err(PROCESSING_LATE)
	);
}

#[test]
fn capture_emits_twenty_millisecond_48khz_opus_frames() {
	let mut processor = Processor::new().unwrap();
	let at = Instant::now();
	let mut packets = Vec::new();
	for block in 0..2 {
		let frame_at = at + Duration::from_millis(block * 10);
		packets.extend(
			processor
				.capture(&[0.1; PROCESSING_BLOCK_SAMPLES], frame_at, frame_at, |_| {})
				.unwrap(),
		);
	}
	assert_eq!(packets.len(), 1);
	assert!(packets[0].data.len() <= MAX_ENCODED_OPUS_BYTES);
	let mut decoder = Decoder::new(SAMPLE_RATE, Channels::Mono).unwrap();
	let mut decoded = [0.0; OPUS_FRAME_SAMPLES];
	assert_eq!(
		decoder
			.decode_float(&packets[0].data, &mut decoded, false)
			.unwrap(),
		OPUS_FRAME_SAMPLES
	);
}

#[test]
fn reset_ignores_audio_captured_before_it() {
	let mut processor = Processor::new().unwrap();
	let captured = Instant::now();
	let block = [0.25; PROCESSING_BLOCK_SAMPLES];
	assert!(
		processor
			.capture(&block, captured, captured, |_| {})
			.unwrap()
			.is_empty()
	);
	assert_eq!(
		processor
			.capture(
				&block,
				captured + Duration::from_millis(10),
				captured + Duration::from_secs(1),
				|_| {}
			)
			.err(),
		Some(PROCESSING_LATE)
	);

	processor.reset().unwrap();
	// Backlog queued before the reset, such as audio from across an unmute,
	// never reaches the encoder.
	for _ in 0..4 {
		assert!(
			processor
				.capture(&block, captured, captured, |_| {})
				.unwrap()
				.is_empty()
		);
	}
	// Fresh capture starts a new packet instead of completing old history.
	let fresh = Instant::now();
	assert!(
		processor
			.capture(&block, fresh, fresh, |_| {})
			.unwrap()
			.is_empty()
	);
	let next = fresh + Duration::from_millis(10);
	assert_eq!(processor.capture(&block, next, next, |_| {}).unwrap().len(), 1);
}

#[test]
fn capture_gap_discards_partial_history_but_keeps_reset_cutoff() {
	// Every chunk was captured after the last reset but is processed later,
	// as when chunks wait in the capture queue.
	let captured_from = Instant::now().checked_sub(Duration::from_secs(10)).unwrap();
	let mut processor = Processor::new().unwrap();
	let mut fresh = Processor::new().unwrap();
	processor.cutoff = captured_from;
	fresh.cutoff = captured_from;
	for index in 0..3 {
		let at = captured_from + Duration::from_millis(index * 5);
		assert!(
			processor
				.capture(&[0.25; 240], at, at, |_| {})
				.unwrap()
				.is_empty()
		);
	}

	let resumed = captured_from + Duration::from_millis(100);
	let mut packets = Vec::new();
	let mut expected = Vec::new();
	for index in 0..8 {
		let at = resumed + Duration::from_millis(index * 5);
		for (processor, packets) in [(&mut processor, &mut packets), (&mut fresh, &mut expected)] {
			packets.extend(
				processor
					.capture(&[0.0; 240], at, at, |_| {})
					.unwrap()
					.into_iter()
					.map(|packet| (packet.at, packet.data)),
			);
		}
	}
	assert!(!packets.is_empty());
	assert_eq!(packets, expected);
}

#[test]
fn capture_timestamp_jitter_within_tolerance_keeps_partial_audio() {
	for jitter_ms in [-2_i64, 2] {
		let mut processor = Processor::new().unwrap();
		let start = Instant::now();
		for index in 0..3 {
			let at = start + Duration::from_millis(index * 5);
			assert!(
				processor
					.capture(&[0.1; 240], at, at, |_| {})
					.unwrap()
					.is_empty()
			);
		}
		let at = start + Duration::from_millis((15 + jitter_ms) as u64);
		assert_eq!(
			processor
				.capture(&[0.1; 240], at, at, |_| {})
				.unwrap()
				.len(),
			1
		);
	}
}
