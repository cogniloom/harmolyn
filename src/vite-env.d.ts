/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Control endpoint the app connects to by default on launch. */
  readonly VITE_XOREIN_CONTROL_ENDPOINT?: string;
  /** Public URL where this app's source (Corresponding Source, AGPL §13) is published. */
  readonly VITE_SOURCE_URL?: string;
  /** Enables experimental QR pairing UI only when a backend pairing endpoint exists. */
  readonly VITE_ENABLE_QR_PAIRING?: string;
  /** Override the relay libp2p peer ID (for staging/testnet builds). */
  readonly VITE_RELAY_PEER_ID?: string;
  /** Override the relay multiaddr (for staging/testnet builds). */
  readonly VITE_RELAY_MULTIADDR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
