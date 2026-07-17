import { describe, expect, it } from 'vitest';

import {
  getEmbedSignatureForInitialization,
  MAX_EMBED_SIGNATURE_BYTES,
  parseEmbedSignature,
} from '../utils/embed-signature';
import { ZSignDocumentEmbedDataSchema } from './embed-document-sign-schema';

const PNG_PREFIX = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_PREFIX = [0xff, 0xd8, 0xff, 0xe0];

const dataUrl = (mime: 'image/png' | 'image/jpeg', bytes: number[]) =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

describe('parseEmbedSignature', () => {
  it.each([
    ['PNG', dataUrl('image/png', [...PNG_PREFIX, 0x00])],
    ['JPEG', dataUrl('image/jpeg', [...JPEG_PREFIX, 0x00])],
  ])('accepts a canonical %s image data URL', (_label, signature) => {
    expect(parseEmbedSignature(signature)).toBe(signature);
    expect(ZSignDocumentEmbedDataSchema.parse({ signature }).signature).toBe(signature);
  });

  it.each([
    ['typed text', 'Dr Vet'],
    ['ordinary URL', 'https://example.com/signature.png'],
    ['SVG', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['GIF', 'data:image/gif;base64,R0lGODlh'],
    ['WebP', 'data:image/webp;base64,UklGRg=='],
    ['malformed base64', 'data:image/png;base64,%%%'],
    ['noncanonical one-byte padding bits', 'data:image/png;base64,iVBORw0KGgoAAB=='],
    ['noncanonical two-byte padding bits', 'data:image/png;base64,iVBORw0KGgoAAAB='],
    ['PNG MIME with JPEG bytes', dataUrl('image/png', JPEG_PREFIX)],
    ['JPEG MIME with PNG bytes', dataUrl('image/jpeg', PNG_PREFIX)],
  ])('drops %s without rejecting the remaining embed data', (_label, signature) => {
    expect(parseEmbedSignature(signature)).toBeUndefined();
    expect(ZSignDocumentEmbedDataSchema.parse({ name: 'Veterinarian', signature })).toEqual(
      expect.objectContaining({ name: 'Veterinarian', signature: undefined }),
    );
  });

  it('drops a decoded image larger than 1 MiB while accepting the exact boundary', () => {
    const atBoundary = dataUrl('image/png', [...PNG_PREFIX, ...new Array(MAX_EMBED_SIGNATURE_BYTES - 8).fill(0)]);
    const oversized = dataUrl('image/png', [...PNG_PREFIX, ...new Array(MAX_EMBED_SIGNATURE_BYTES - 7).fill(0)]);

    expect(parseEmbedSignature(atBoundary)).toBe(atBoundary);
    expect(parseEmbedSignature(oversized)).toBeUndefined();
  });

  it('initializes a valid candidate only when upload or draw image mode is enabled', () => {
    const signature = dataUrl('image/png', [...PNG_PREFIX, 0x00]);

    expect(getEmbedSignatureForInitialization(signature, true, false)).toBe(signature);
    expect(getEmbedSignatureForInitialization(signature, false, true)).toBe(signature);
    expect(getEmbedSignatureForInitialization(signature, false, false)).toBeUndefined();
  });
});
