import { describe, expect, it } from 'vitest';
import { EventBuffer } from './event-buffer.js';
import { PROTOCOL_VERSION, type ChannelAEvent } from './wire.js';

function mkEvent(eventId: number, text: string): ChannelAEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    ts: 1000 + eventId,
    uid: 'u',
    characterId: 'c',
    type: 'text',
    text,
  };
}

describe('EventBuffer', () => {
  it('assigns monotonic event ids starting at 1', () => {
    const b = new EventBuffer();
    const a = b.append((id) => mkEvent(id, 'a'));
    const c = b.append((id) => mkEvent(id, 'b'));
    expect(a.eventId).toBe(1);
    expect(c.eventId).toBe(2);
    expect(b.lastEventId).toBe(2);
  });

  it('replays since cursor', () => {
    const b = new EventBuffer();
    b.append((id) => mkEvent(id, 'a'));
    b.append((id) => mkEvent(id, 'b'));
    b.append((id) => mkEvent(id, 'c'));
    const since1 = b.since(1).map((e) => (e as { text: string }).text);
    expect(since1).toEqual(['b', 'c']);
    expect(b.since(3)).toEqual([]);
    // since 0 returns everything still in the buffer
    expect(b.since(0).length).toBe(3);
  });

  it('drops oldest when capacity is reached', () => {
    const b = new EventBuffer(2);
    b.append((id) => mkEvent(id, 'a'));
    b.append((id) => mkEvent(id, 'b'));
    b.append((id) => mkEvent(id, 'c'));
    expect(b.size).toBe(2);
    expect(b.oldestEventId).toBe(2);
    expect(b.lastEventId).toBe(3);
    // Reconnecting with `since=0` only gets what's still buffered.
    const replay = b.since(0);
    expect(replay.length).toBe(2);
    expect((replay[0] as { text: string }).text).toBe('b');
  });

  it('rejects non-positive capacity', () => {
    expect(() => new EventBuffer(0)).toThrow();
  });
});
