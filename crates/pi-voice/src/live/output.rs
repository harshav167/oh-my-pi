//! Remote playout lane for the native live peer.
//!
//! Owns the RTP receive loop and the playout scheduler. Both hold a
//! `Weak<LivePeerCore>` and touch the parent's private mute flag, audio
//! processor, and counters directly — permitted because this is a child module
//! of `live`.

use std::{
	sync::{Arc, Weak, atomic::Ordering},
	time::Instant,
};

use opus::{Channels, Decoder};
use parking_lot::Mutex;
use webrtc::{api::media_engine::MIME_TYPE_OPUS, track::track_remote::TrackRemote};

use super::{
	AUDIO_SAMPLE_RATE, LivePeerCore, PLAYBACK_CUSHION_SAMPLES, PLAYOUT_TICK,
	playout::{PLAYOUT_BLOCK_SAMPLES, Playout, PlayoutBlock},
};
use crate::audio::PlaybackWriter;

/// Read remote RTP into the adaptive playout buffer and render it on a clock.
pub(super) async fn receive_output_audio(
	track: Arc<TrackRemote>,
	playback_tx: PlaybackWriter,
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
	let decoder = match Decoder::new(AUDIO_SAMPLE_RATE, Channels::Mono) {
		Ok(decoder) => decoder,
		Err(error) => {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Failed to initialize the live Opus decoder: {error}"));
			}
			return;
		},
	};
	let playout = Arc::new(Mutex::new(Playout::new(decoder)));
	let scheduler = tokio::spawn(run_playout(Arc::clone(&playout), playback_tx, core.clone()));

	let epoch = Instant::now();
	loop {
		let packet = match track.read_rtp().await {
			Ok((packet, _attributes)) => packet,
			Err(error) => {
				if let Some(core) = core.upgrade()
					&& !core.closing.load(Ordering::Acquire)
				{
					core.report_failure(format!("Live remote audio track failed: {error}"));
				}
				break;
			},
		};
		playout.lock().accept(
			packet.header.sequence_number,
			packet.header.timestamp,
			packet.payload,
			epoch.elapsed().as_secs_f64(),
		);
	}
	scheduler.abort();
	let _ = scheduler.await;
}

/// Emit one 10 ms playout block per tick, paced against the speaker's own
/// queue.
///
/// Output mute is applied here so the audio processor analyzes exactly the
/// block the speaker will render.
async fn run_playout(
	playout: Arc<Mutex<Playout>>,
	playback_tx: PlaybackWriter,
	core: Weak<LivePeerCore>,
) {
	let mut ticker = tokio::time::interval(PLAYOUT_TICK);
	ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
	let mut block = [0.0f32; PLAYOUT_BLOCK_SAMPLES];
	loop {
		ticker.tick().await;
		let Some(core) = core.upgrade() else {
			return;
		};
		if core.closing.load(Ordering::Acquire) {
			return;
		}
		let stats = playout.lock().stats();
		core
			.counters
			.output_packets
			.store(stats.packets, Ordering::Relaxed);
		core
			.counters
			.output_sequence_gaps
			.store(stats.sequence_gaps, Ordering::Relaxed);
		core
			.counters
			.output_concealed_frames
			.store(stats.concealed_frames, Ordering::Relaxed);
		core
			.counters
			.output_dropped_samples
			.store(stats.dropped_samples, Ordering::Relaxed);

		// The playout buffer already holds the adaptive target, so the speaker
		// ring only needs a small cushion against scheduler drift; refilling it
		// to the target would double-count the delay. A fast timer must throttle
		// rather than drive the ring to its cap, so a full queue skips the tick.
		if playback_tx.queued_samples() >= PLAYBACK_CUSHION_SAMPLES + PLAYOUT_BLOCK_SAMPLES {
			continue;
		}
		let mut emitted = 0;
		while emitted == 0 || playback_tx.queued_samples() < PLAYBACK_CUSHION_SAMPLES {
			let produced = playout.lock().pull(&mut block);
			if core.output_muted.load(Ordering::Acquire) {
				block.fill(0.0);
			}
			if let Some(reason) = core.processing.analyze_render(&block) {
				core.report_diagnostic(&reason);
			}
			if playback_tx.write(&block).is_err() {
				return;
			}
			emitted += 1;
			if produced == PlayoutBlock::Silence || emitted >= 3 {
				break;
			}
		}
	}
}
