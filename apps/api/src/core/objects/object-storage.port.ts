export interface ObjectStoragePort {
  put(key: string, body: Uint8Array, contentType: 'application/pdf' | 'text/csv'): Promise<void>;
  signedGetUrl(key: string, fileName: string, contentType: string,
    expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
