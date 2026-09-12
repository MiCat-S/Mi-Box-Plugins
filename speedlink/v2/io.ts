import type {FileHandle} from "node:fs/promises";

export async function writeAll(file: Pick<FileHandle, "write">, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const remaining = chunk.byteLength - offset;
    const {bytesWritten} = await file.write(chunk, offset, remaining, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error("File write made invalid progress");
    }
    offset += bytesWritten;
  }
}
