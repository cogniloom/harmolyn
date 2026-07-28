/* eslint-disable react-refresh/only-export-components */
// P0 transport spike test page — dev only, not included in production build.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createXoreinNode, circuitAddrs, RELAY_PEER_ID, RELAY_MULTIADDR } from './native/transport/node';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  callFamily,
  frameMessage, unframeMessage,
  encodePeerStreamRequest, decodePeerStreamRequest,
  encodePeerStreamResponse, decodePeerStreamResponse,
  type PeerStreamRequest, type PeerStreamResponse,
} from './native/families/peerstream';
import { PROTOCOLS } from './native/families/families';
import type { Libp2p } from 'libp2p';

declare global {
  interface Window {
    __p0: {
      createNode: typeof createXoreinNode;
      circuitAddrs: typeof circuitAddrs;
      callFamily: typeof callFamily;
      frameMessage: typeof frameMessage;
      unframeMessage: typeof unframeMessage;
      encodePeerStreamRequest: typeof encodePeerStreamRequest;
      decodePeerStreamRequest: typeof decodePeerStreamRequest;
      encodePeerStreamResponse: typeof encodePeerStreamResponse;
      decodePeerStreamResponse: typeof decodePeerStreamResponse;
      multiaddr: typeof multiaddr;
      peerIdFromString: typeof peerIdFromString;
      PROTOCOLS: typeof PROTOCOLS;
      RELAY_PEER_ID: typeof RELAY_PEER_ID;
      RELAY_MULTIADDR: typeof RELAY_MULTIADDR;
      node: Libp2p | null;
    };
  }
}

function P0TestApp() {
  return (
    <div id="p0-root" style={{ fontFamily: 'monospace', padding: '1em' }}>
      <h2>xorein P0 transport spike</h2>
      <p>Use <code>window.__p0.createNode()</code> to start a libp2p node.</p>
      <pre id="p0-output">ready</pre>
    </div>
  );
}

window.__p0 = {
  createNode: createXoreinNode,
  circuitAddrs,
  callFamily,
  frameMessage,
  unframeMessage,
  encodePeerStreamRequest,
  decodePeerStreamRequest,
  encodePeerStreamResponse,
  decodePeerStreamResponse,
  multiaddr,
  peerIdFromString,
  PROTOCOLS,
  RELAY_PEER_ID,
  RELAY_MULTIADDR,
  node: null,
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<P0TestApp />);
