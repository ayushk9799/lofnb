// Only passive media formats are accepted; ignore client filenames and MIME claims.
export function detectMedia(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    const hex = buffer.subarray(0, 12).toString("hex");
    const ascii = buffer.subarray(0, 12).toString("ascii");
    if (hex.startsWith("89504e470d0a1a0a")) return {ext:"png", mimeType:"image/png"};
    if (hex.startsWith("ffd8ff")) return {ext:"jpg", mimeType:"image/jpeg"};
    if (/^GIF8[79]a/.test(ascii)) return {ext:"gif", mimeType:"image/gif"};
    if (ascii.startsWith("RIFF") && ascii.endsWith("WEBP")) return {ext:"webp", mimeType:"image/webp"};
    if (ascii.startsWith("RIFF") && ascii.endsWith("WAVE")) return {ext:"wav", mimeType:"audio/wav"};
    if (ascii.startsWith("OggS")) return {ext:"ogg", mimeType:"audio/ogg"};
    if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return {ext:"m4a", mimeType:"audio/mp4"};
    if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return {ext:"aac", mimeType:"audio/aac"};
    if (ascii.startsWith("ID3") || (buffer[0] === 255 && (buffer[1] & 224) === 224)) return {ext:"mp3", mimeType:"audio/mpeg"};
    return null;
}
