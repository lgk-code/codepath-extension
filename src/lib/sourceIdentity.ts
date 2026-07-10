type IdentityEntry = {
  path: string;
  content: Uint8Array;
};

export async function digestZipEntries(entries: IdentityEntry[]): Promise<string> {
  const encoder = new TextEncoder();
  const frames: Uint8Array[] = [];
  let totalBytes = 0;

  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = encoder.encode(entry.path);
    const contentBytes = new Uint8Array(entry.content.byteLength);
    contentBytes.set(entry.content);
    const contentDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", contentBytes));
    const frame = new Uint8Array(8 + path.byteLength + contentDigest.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, path.byteLength);
    frame.set(path, 4);
    view.setUint32(4 + path.byteLength, entry.content.byteLength);
    frame.set(contentDigest, 8 + path.byteLength);
    frames.push(frame);
    totalBytes += frame.byteLength;
  }

  const input = new Uint8Array(totalBytes);
  let offset = 0;
  for (const frame of frames) {
    input.set(frame, offset);
    offset += frame.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
