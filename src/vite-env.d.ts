/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build-time override for the JEV endpoint. */
  readonly VITE_JEV_BASE_URL?: string;
  /** Optional build-time override for the JEV model id. */
  readonly VITE_JEV_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
