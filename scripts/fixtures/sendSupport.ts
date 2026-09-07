// Only the conversation test build aliases this module. No real network transport.
import { readBrowserChatActionSupport as readRealSupport } from '../../src/protocol/client';
import { isSendFixture } from './sendRuntime';
export * from '../../src/protocol/client';
export function readBrowserChatActionSupport() {
  return isSendFixture
    ? { mode: 'connected' as const, detail: 'Simulated send transport; no network.', canPersistLocally: false, canAttemptAttachments: false }
    : readRealSupport();
}
