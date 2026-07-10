export async function sha256Digest(parts: Array<string | Uint8Array>): Promise<string> {
  const encoder = new TextEncoder();
  const encodedParts = parts.map((part) => {
    if (typeof part === "string") return encoder.encode(part);
    const copy = new Uint8Array(part.byteLength);
    copy.set(part);
    return copy;
  });
  const totalBytes = encodedParts.reduce((total, part) => total + 4 + part.byteLength, 0);
  const framed = new Uint8Array(totalBytes);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of encodedParts) {
    view.setUint32(offset, part.byteLength);
    offset += 4;
    framed.set(part, offset);
    offset += part.byteLength;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
