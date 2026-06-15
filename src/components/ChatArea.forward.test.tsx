import { describe, expect, it, vi } from 'vitest';
import { describeForwardDeliveryOutcome, sendForwardMessageBatch } from './forwardDelivery';
import type { Message, XoreinRuntimeSnapshot } from '@/types';
import type { XoreinMessageRecord } from '@/lib/xoreinControl';

describe('sendForwardMessageBatch', () => {
  const runtime = { control_endpoint: 'http://xorein.local' } as XoreinRuntimeSnapshot;
  const message = { id: 'm1', content: 'hello world' } as Message;

  it('continues through later destinations when one forward fails', async () => {
    const sendChannel = vi.fn(async () => ({ id: 'c1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'me', body: 'hello world' } as XoreinMessageRecord));
    const sendDm = vi.fn(async () => {
      throw new Error('dm failed');
    });

    const outcome = await sendForwardMessageBatch(
      runtime,
      message,
      [
        { id: 'c1', label: 'general', sublabel: '#general', type: 'channel' },
        { id: 'd1', label: 'nova', sublabel: '@nova', type: 'dm' },
      ],
      '  note  ',
      sendChannel,
      sendDm,
    );

    expect(sendChannel).toHaveBeenCalledTimes(1);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendChannel).toHaveBeenCalledWith(runtime, 'c1', 'note\n\nhello world', { forwarded_from: 'm1' });
    expect(sendDm).toHaveBeenCalledWith(runtime, 'd1', 'note\n\nhello world', { forwarded_from: 'm1' });
    expect(outcome.sent).toBe(1);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.destination.id).toBe('d1');
  });


  it('summarizes failed destinations by label', () => {
    const summary = describeForwardDeliveryOutcome(
      {
        sent: 1,
        failed: [
          { destination: { id: 'd1', label: 'nova', sublabel: '@nova', type: 'dm' }, error: new Error('dm failed') },
        ],
      },
      'm1',
    );

    expect(summary.tone).toBe('info');
    expect(summary.text).toContain('failed: nova');
  });

  it('sends the raw message when the note is blank', async () => {
    const sendChannel = vi.fn(async () => ({ id: 'c1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'me', body: 'hello world' } as XoreinMessageRecord));
    const outcome = await sendForwardMessageBatch(
      runtime,
      message,
      [{ id: 'c1', label: 'general', sublabel: '#general', type: 'channel' }],
      '   ',
      sendChannel,
      vi.fn(),
    );

    expect(sendChannel).toHaveBeenCalledWith(runtime, 'c1', 'hello world', { forwarded_from: 'm1' });
    expect(outcome.sent).toBe(1);
    expect(outcome.failed).toHaveLength(0);
  });
});
