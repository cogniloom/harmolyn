import type { Message, XoreinRuntimeSnapshot } from '@/types';
import { sendChannelMessage, sendDmMessage } from '@/lib/xoreinControl';

export interface ForwardDestination {
  id: string;
  label: string;
  sublabel: string;
  type: 'channel' | 'dm';
}

export interface ForwardDeliveryFailure {
  destination: ForwardDestination;
  error: unknown;
}

export interface ForwardDeliveryOutcome {
  sent: number;
  failed: ForwardDeliveryFailure[];
}

export type ForwardFeedbackTone = 'info' | 'success' | 'error';

export function describeForwardDeliveryOutcome(outcome: ForwardDeliveryOutcome, messageId: string): { tone: ForwardFeedbackTone; text: string; toastType: 'message' | 'system' } {
  if (outcome.failed.length === 0) {
    return { tone: 'success', text: `Forwarded ${messageId} through xorein.`, toastType: 'message' };
  }

  const failedTargets = outcome.failed.map((failure) => failure.destination.label).filter(Boolean);
  const failedLabel = failedTargets.length > 0 ? failedTargets.join(', ') : 'one or more destinations';

  if (outcome.sent > 0) {
    return {
      tone: 'info',
      text: `Forwarded ${outcome.sent} of ${outcome.sent + outcome.failed.length} destinations for ${messageId}; failed: ${failedLabel}.`,
      toastType: 'system',
    };
  }

  const firstError = outcome.failed[0]?.error;
  return {
    tone: 'error',
    text: firstError instanceof Error
      ? `${firstError.message} (${failedLabel})`
      : `Failed to forward ${messageId}; failed destinations: ${failedLabel}.`,
    toastType: 'system',
  };
}

export async function sendForwardMessageBatch(
  runtimeSnapshot: XoreinRuntimeSnapshot | null,
  forwardingMessage: Message,
  destinations: ForwardDestination[],
  note: string,
  sendChannelFn: typeof sendChannelMessage = sendChannelMessage,
  sendDmFn: typeof sendDmMessage = sendDmMessage,
): Promise<ForwardDeliveryOutcome> {
  if (!runtimeSnapshot) {
    throw new Error('The local xorein runtime is unavailable.');
  }

  const payload = note.trim() ? `${note.trim()}\n\n${forwardingMessage.content}` : forwardingMessage.content;
  const outcome: ForwardDeliveryOutcome = { sent: 0, failed: [] };

  for (const destination of destinations) {
    try {
      if (destination.type === 'channel') {
        await sendChannelFn(runtimeSnapshot, destination.id, payload, { forwarded_from: forwardingMessage.id });
      } else {
        await sendDmFn(runtimeSnapshot, destination.id, payload, { forwarded_from: forwardingMessage.id });
      }
      outcome.sent += 1;
    } catch (error) {
      outcome.failed.push({ destination, error });
    }
  }

  return outcome;
}
