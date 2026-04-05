interface ImportMetaEnv {
  readonly VITE_KILLSTATA_SERVER_HOST: string
  readonly VITE_KILLSTATA_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
