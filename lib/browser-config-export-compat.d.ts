export {};

declare global {
  interface SubtleCrypto {
    digest(
      algorithm: AlgorithmIdentifier,
      data: Uint8Array<ArrayBufferLike>,
    ): Promise<ArrayBuffer>;
  }
}

declare module "./browser-config-export" {
  interface BrowserFileHandle {
    createWritable(): Promise<{
      write(data: Uint8Array<ArrayBufferLike> | BufferSource | Blob | string): Promise<void>;
      close(): Promise<void>;
    }>;
  }
}
