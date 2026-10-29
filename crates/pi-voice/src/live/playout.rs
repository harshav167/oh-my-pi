use std::{
	sync::Arc,
	time::{Duration, Instant},
};

use bytes::Bytes;
use opus::Decoder;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const JITTER_LATENCY: Duration = Duration::from_millis(60);
const PLAYOUT_FRAME_DURATION: Duration = Duration::from_millis(20);
pub(super) const MAX_INCOMING_PACKETS: usize = 64;
pub(super) const MAX_INCOMING_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_PACKET_BYTES: usize = 64 * 1024;
pub(super) const MAX_DECODED_OPUS_SAMPLES: usize = 5_760;
const OPUS_LOSS_SAMPLES: usize = 960;
const MAX_REORDER_DISTANCE: u16 = MAX_INCOMING_PACKETS as u16;
/// Each concealment frame adds 20 ms of playback, never additional latency
/// from a second wait for the reorder deadline.
const MAX_CONCEALED_PACKETS: u8 = 4;
#[derive(Clone)]
pub(super) struct IngressBudget {
	packets: Arc<Semaphore>,
	bytes:   Arc<Semaphore>,
}

impl IngressBudget {
	pub(super) fn new() -> Self {
		Self {
			packets: Arc::new(Semaphore::new(MAX_INCOMING_PACKETS)),
			bytes:   Arc::new(Semaphore::new(MAX_INCOMING_BYTES)),
		}
	}

	pub(super) fn try_acquire(
		&self,
		size: usize,
	) -> Result<Option<PacketBudgetPermit>, &'static str> {
		if size > MAX_PACKET_BYTES {
			return Err("incoming RTP packet exceeds 64 KiB");
		}
		let Ok(packet) = Arc::clone(&self.packets).try_acquire_owned() else {
			return Ok(None);
		};
		let Ok(bytes) = Arc::clone(&self.bytes).try_acquire_many_owned(size as u32) else {
			return Ok(None);
		};
		Ok(Some(PacketBudgetPermit { _packet: packet, _bytes: bytes }))
	}
}

pub(super) struct PacketBudgetPermit {
	_packet: OwnedSemaphorePermit,
	_bytes:  OwnedSemaphorePermit,
}

pub(super) struct IncomingPacket {
	pub(super) sequence:   u16,
	pub(super) payload:    Bytes,
	pub(super) arrived_at: Instant,
	pub(super) _permit:    PacketBudgetPermit,
}

pub(super) enum JitterEvent {
	Packet(IncomingPacket),
	Lost,
}

#[derive(Default)]
pub(super) struct JitterBuffer {
	expected:     Option<u16>,
	next_play_at: Option<Instant>,
	pending:      Vec<IncomingPacket>,
	/// Consecutive `Lost` events since a packet last played.
	concealed:    u8,
}
impl JitterBuffer {
	pub(super) fn clear(&mut self) {
		self.expected = None;
		self.next_play_at = None;
		self.pending.clear();
		self.concealed = 0;
	}

	pub(super) fn push(&mut self, packet: IncomingPacket) {
		// With no slot scheduled, before the first packet or after an idle
		// stretch, the next arrival starts a new run, even one numbered behind
		// slots that were concealed while the sender was silent.
		let (Some(expected), Some(_)) = (self.expected, self.next_play_at) else {
			self.pending.clear();
			self.expected = Some(packet.sequence);
			self.next_play_at = Some(packet.arrived_at + JITTER_LATENCY);
			self.concealed = 0;
			self.pending.push(packet);
			return;
		};
		let distance = packet.sequence.wrapping_sub(expected);
		if distance >= u16::MAX / 2 {
			return;
		}
		if self
			.pending
			.iter()
			.any(|queued| queued.sequence == packet.sequence)
		{
			return;
		}
		if distance > MAX_REORDER_DISTANCE {
			// A discontinuity starts a new media run instead of synthesizing
			// an unbounded run of concealment frames.
			self.pending.clear();
			self.expected = Some(packet.sequence);
			self.next_play_at = Some(packet.arrived_at + JITTER_LATENCY);
			self.concealed = 0;
		}
		self.pending.push(packet);
	}

	pub(super) const fn next_deadline(&self) -> Option<Instant> {
		self.next_play_at
	}

	pub(super) fn pop_ready(&mut self, now: Instant) -> Option<JitterEvent> {
		let expected = self.expected?;
		let play_at = self.next_play_at?;
		if now < play_at {
			return None;
		}
		// A wake less than a frame late keeps the 20 ms grid; after a whole
		// missed frame the grid restarts from now instead of catching up.
		let next_slot = play_at + PLAYOUT_FRAME_DURATION;
		self.next_play_at = Some(if now < next_slot {
			next_slot
		} else {
			now + PLAYOUT_FRAME_DURATION
		});
		if self
			.pending
			.iter()
			.any(|packet| packet.sequence == expected)
		{
			let index = self
				.pending
				.iter()
				.position(|packet| packet.sequence == expected)?;
			let packet = self.pending.swap_remove(index);
			self.expected = Some(expected.wrapping_add(1));
			self.concealed = 0;
			return Some(JitterEvent::Packet(packet));
		}
		if self.concealed < MAX_CONCEALED_PACKETS {
			self.concealed += 1;
			self.expected = Some(expected.wrapping_add(1));
			return Some(JitterEvent::Lost);
		}
		if self.pending.is_empty() {
			self.next_play_at = None;
			return None;
		}
		// A loss burst longer than the concealment allowance resumes at the
		// earliest packet that actually arrived, rather than stalling again.
		let next = self
			.pending
			.iter()
			.map(|packet| packet.sequence)
			.min_by_key(|sequence| sequence.wrapping_sub(expected))?;
		let index = self
			.pending
			.iter()
			.position(|packet| packet.sequence == next)?;
		let packet = self.pending.swap_remove(index);
		self.expected = Some(next.wrapping_add(1));
		self.concealed = 0;
		Some(JitterEvent::Packet(packet))
	}
}

pub(super) fn decode_opus(
	decoder: &mut Decoder,
	packet: Option<&[u8]>,
	decoded: &mut [f32],
) -> Result<usize, opus::Error> {
	match packet {
		Some(packet) => decoder.decode_float(packet, decoded, false),
		None => decoder.decode_float(&[], &mut decoded[..OPUS_LOSS_SAMPLES], false),
	}
}

#[cfg(test)]
mod tests {
	use opus::{Application, Channels, Encoder};

	use super::*;

	fn packet(budget: &IngressBudget, sequence: u16, at: Instant) -> IncomingPacket {
		IncomingPacket {
			sequence,
			payload: Bytes::from_static(&[0]),
			arrived_at: at,
			_permit: budget.try_acquire(13).unwrap().unwrap(),
		}
	}

	/// Play a fixed number of consecutive slots, preserving the playout cadence.
	fn play_frames(jitter: &mut JitterBuffer, start: Instant, count: u32) -> Vec<Option<u16>> {
		(0..count)
			.map(|index| {
				match jitter
					.pop_ready(start + PLAYOUT_FRAME_DURATION * index)
					.expect("one event per scheduled slot")
				{
					JitterEvent::Packet(packet) => Some(packet.sequence),
					JitterEvent::Lost => None,
				}
			})
			.collect()
	}

	#[test]
	fn packets_reorder_before_the_sixty_millisecond_deadline() {
		let budget = IngressBudget::new();
		let now = Instant::now();
		let mut jitter = JitterBuffer::default();
		jitter.push(packet(&budget, 40, now));
		assert!(jitter.pop_ready(now).is_none());
		jitter.push(packet(&budget, 42, now));
		assert_eq!(jitter.next_deadline(), Some(now + JITTER_LATENCY));
		assert!(jitter.pop_ready(now + Duration::from_millis(59)).is_none());
		jitter.push(packet(&budget, 41, now + Duration::from_millis(59)));
		assert!(
			matches!(jitter.pop_ready(now + JITTER_LATENCY), Some(JitterEvent::Packet(packet)) if packet.sequence == 40)
		);
		assert!(
			matches!(jitter.pop_ready(now + JITTER_LATENCY + PLAYOUT_FRAME_DURATION), Some(JitterEvent::Packet(packet)) if packet.sequence == 41)
		);
		assert!(
			matches!(jitter.pop_ready(now + JITTER_LATENCY + 2 * PLAYOUT_FRAME_DURATION), Some(JitterEvent::Packet(packet)) if packet.sequence == 42)
		);
	}

	#[test]
	fn a_lost_sequence_becomes_an_opus_concealment_frame() {
		let budget = IngressBudget::new();
		let now = Instant::now();
		let mut jitter = JitterBuffer::default();
		jitter.push(packet(&budget, 100, now));
		assert!(jitter.pop_ready(now).is_none());
		jitter.push(packet(&budget, 102, now));
		assert_eq!(jitter.next_deadline(), Some(now + JITTER_LATENCY));
		assert!(jitter.pop_ready(now + Duration::from_millis(59)).is_none());
		assert!(
			matches!(jitter.pop_ready(now + JITTER_LATENCY), Some(JitterEvent::Packet(packet)) if packet.sequence == 100)
		);
		assert!(matches!(
			jitter.pop_ready(now + JITTER_LATENCY + PLAYOUT_FRAME_DURATION),
			Some(JitterEvent::Lost)
		));
		assert!(
			matches!(jitter.pop_ready(now + JITTER_LATENCY + 2 * PLAYOUT_FRAME_DURATION), Some(JitterEvent::Packet(packet)) if packet.sequence == 102)
		);

		let mut encoder = Encoder::new(48_000, Channels::Mono, Application::Voip).unwrap();
		let mut bytes = [0; 1_275];
		let length = encoder.encode_float(&[0.1; 960], &mut bytes).unwrap();
		let mut decoder = Decoder::new(48_000, Channels::Mono).unwrap();
		let mut decoded = vec![0.0; MAX_DECODED_OPUS_SAMPLES];
		assert_eq!(decode_opus(&mut decoder, Some(&bytes[..length]), &mut decoded).unwrap(), 960);
		let concealed = decode_opus(&mut decoder, None, &mut decoded).unwrap();
		assert_eq!(concealed, OPUS_LOSS_SAMPLES);
		assert!(decoded[..concealed].iter().all(|sample| sample.is_finite()));
	}

	#[test]
	fn burst_loss_conceals_at_most_four_frames_then_plays_the_next_packet() {
		let budget = IngressBudget::new();
		let now = Instant::now();
		let late = now + JITTER_LATENCY;
		let mut jitter = JitterBuffer::default();
		jitter.push(packet(&budget, 65_533, now));
		assert!(jitter.pop_ready(now).is_none());

		// Ten packets, 65534 through 7, are lost across the sequence wrap.
		jitter.push(packet(&budget, 8, now));
		jitter.push(packet(&budget, 9, now));
		assert_eq!(play_frames(&mut jitter, late, 7), [
			Some(65_533),
			None,
			None,
			None,
			None,
			Some(8),
			Some(9)
		]);

		// Audio arriving after its slot was concealed or skipped never plays.
		jitter.push(packet(&budget, 0, late));
		jitter.push(packet(&budget, 5, late));
		assert!(
			jitter
				.pop_ready(late + 6 * PLAYOUT_FRAME_DURATION)
				.is_none()
		);

		// Playing a packet restores the full concealment allowance.
		let next_run = late + 7 * PLAYOUT_FRAME_DURATION;
		jitter.push(packet(&budget, 16, next_run));
		assert_eq!(play_frames(&mut jitter, next_run, 5), [None, None, None, None, Some(16)]);
		// Nothing, late arrivals included, still holds ingress budget.
		assert_eq!(budget.packets.available_permits(), MAX_INCOMING_PACKETS);
	}

	#[test]
	fn a_burst_plays_at_twenty_millisecond_cadence_without_catching_up() {
		let budget = IngressBudget::new();
		let now = Instant::now();
		let mut jitter = JitterBuffer::default();
		for sequence in 0..5 {
			jitter.push(packet(&budget, sequence, now));
		}
		assert!(jitter.pop_ready(now).is_none());
		for frame in 0..5_u64 {
			let play_at = now + JITTER_LATENCY + PLAYOUT_FRAME_DURATION * frame as u32;
			assert!(jitter.pop_ready(play_at).is_some());
			assert!(jitter.pop_ready(play_at).is_none());
			if frame < 4 {
				assert!(
					jitter
						.pop_ready(play_at + Duration::from_millis(1))
						.is_none()
				);
			}
		}
	}

	#[test]
	fn a_late_wake_does_not_flush_multiple_packets_into_playback() {
		let budget = IngressBudget::new();
		let start = Instant::now();
		let mut jitter = JitterBuffer::default();
		jitter.push(packet(&budget, 10, start));
		jitter.push(packet(&budget, 11, start));
		let late = start + JITTER_LATENCY + 5 * PLAYOUT_FRAME_DURATION;

		assert!(
			matches!(jitter.pop_ready(late), Some(JitterEvent::Packet(packet)) if packet.sequence == 10)
		);
		assert!(jitter.pop_ready(late).is_none());
		assert_eq!(jitter.next_deadline(), Some(late + PLAYOUT_FRAME_DURATION));
		assert!(
			matches!(jitter.pop_ready(late + PLAYOUT_FRAME_DURATION), Some(JitterEvent::Packet(packet)) if packet.sequence == 11)
		);
	}

	#[test]
	fn wakes_less_than_a_frame_late_keep_the_playout_cadence() {
		let budget = IngressBudget::new();
		let start = Instant::now();
		let due = start + JITTER_LATENCY;
		let mut jitter = JitterBuffer::default();
		for sequence in 0..3 {
			jitter.push(packet(&budget, sequence, start));
		}
		// Each wake is 19 ms late, yet every next slot stays on the grid of
		// the first deadline instead of drifting by the timer's lateness.
		for frame in 0..3_u16 {
			let slot = due + PLAYOUT_FRAME_DURATION * u32::from(frame);
			let woke = slot + Duration::from_millis(19);
			assert!(
				matches!(jitter.pop_ready(woke), Some(JitterEvent::Packet(packet)) if packet.sequence == frame)
			);
			assert!(jitter.pop_ready(woke).is_none());
			assert_eq!(jitter.next_deadline(), Some(slot + PLAYOUT_FRAME_DURATION));
		}
	}

	#[test]
	fn idle_playout_stops_its_timer_and_restarts_from_a_new_arrival() {
		let budget = IngressBudget::new();
		let start = Instant::now();
		let due = start + JITTER_LATENCY;
		let mut jitter = JitterBuffer::default();
		jitter.push(packet(&budget, 10, start));
		assert_eq!(play_frames(&mut jitter, due, 5), [Some(10), None, None, None, None]);
		assert!(jitter.pop_ready(due + 5 * PLAYOUT_FRAME_DURATION).is_none());
		assert_eq!(jitter.next_deadline(), None);

		// After a silence the sender resumes at 11, a number already spent on
		// a concealed slot; its first packet still starts the new run.
		let resumed = due + Duration::from_secs(1);
		jitter.push(packet(&budget, 11, resumed));
		assert_eq!(jitter.next_deadline(), Some(resumed + JITTER_LATENCY));
		jitter.push(packet(&budget, 12, resumed));
		assert!(jitter.pop_ready(resumed).is_none());
		assert_eq!(play_frames(&mut jitter, resumed + JITTER_LATENCY, 2), [Some(11), Some(12)]);
		assert_eq!(budget.packets.available_permits(), MAX_INCOMING_PACKETS);
	}

	#[test]
	fn ingress_budget_caps_packets_bytes_and_individual_packet_size() {
		let budget = IngressBudget::new();
		let packet_permits: Vec<_> = (0..MAX_INCOMING_PACKETS)
			.map(|_| budget.try_acquire(1).unwrap().unwrap())
			.collect();
		assert!(budget.try_acquire(1).unwrap().is_none());
		drop(packet_permits);

		let byte_permits: Vec<_> = (0..MAX_INCOMING_BYTES / MAX_PACKET_BYTES)
			.map(|_| budget.try_acquire(MAX_PACKET_BYTES).unwrap().unwrap())
			.collect();
		assert!(budget.try_acquire(1).unwrap().is_none());
		assert!(budget.try_acquire(MAX_PACKET_BYTES + 1).is_err());
		drop(byte_permits);
		assert!(budget.try_acquire(MAX_PACKET_BYTES).unwrap().is_some());
	}
}
