export const MAX_EMBED_SIGNATURE_BYTES = 1024 * 1024;

const PNG_MIME = 'image/png';
const JPEG_MIME = 'image/jpeg';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Accepts only canonical, bounded PNG/JPEG base64 data URLs from an embed hash.
 * Returns the original value so signature bytes never need to be copied into errors.
 */
export const parseEmbedSignature = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(value);

  if (!match) {
    return undefined;
  }

  const mime = match[1];
  const base64 = match[2];

  if (!base64 || !BASE64_PATTERN.test(base64)) {
    return undefined;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedSize = (base64.length / 4) * 3 - padding;

  if (decodedSize <= 0 || decodedSize > MAX_EMBED_SIGNATURE_BYTES) {
    return undefined;
  }

  let bytes: Uint8Array;

  try {
    const decoded = atob(base64);
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }

  const hasPngMagic = PNG_MAGIC_BYTES.every((byte, index) => bytes[index] === byte);
  const hasJpegMagic = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  if (mime === PNG_MIME && hasPngMagic) {
    return value;
  }

  if (mime === JPEG_MIME && hasJpegMagic) {
    return value;
  }

  return undefined;
};

export const getEmbedSignatureForInitialization = (
  candidate: unknown,
  uploadSignatureEnabled: boolean,
  drawSignatureEnabled: boolean,
): string | undefined => {
  if (!uploadSignatureEnabled && !drawSignatureEnabled) {
    return undefined;
  }

  return parseEmbedSignature(candidate);
};
