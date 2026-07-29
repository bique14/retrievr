/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the signaling server, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
