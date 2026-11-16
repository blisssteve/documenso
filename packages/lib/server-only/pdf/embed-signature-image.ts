import { crc32 } from 'node:zlib';

import type { PDFDocument } from '@cantoo/pdf-lib';
import sharp from 'sharp';

export const embedSignatureImage = async (pdf: PDFDocument, value: string) => {
  const base64 = value
    .trim()
    .replace(/^data:[^,]*,/i, '')
    .replace(/\s/g, '');

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (base64.length > 6_990_508 || Math.floor((base64.length * 3) / 4) - padding > 5_242_880) {
    throw new Error('Signature image exceeds 5242880 decoded bytes');
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || (base64.includes('=') && base64.length % 4 !== 0)) {
    throw new Error('Invalid signature image base64');
  }

  const bytes = Buffer.from(base64, 'base64');

  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new Error('Invalid signature image base64');
  }

  // ponytail: MIME is advisory; magic bytes select pdf-lib's existing image decoders.
  const isPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  if (!isPng && !isJpeg) {
    throw new Error('Unsupported signature image format: expected PNG or JPEG');
  }

  if (isPng) {
    let offset = 8;
    let hasIdat = false;
    let hasIend = false;

    // ponytail: sharp ignores some PNG CRCs; check every chunk before decoding pixels.
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      const type = bytes.toString('ascii', offset + 4, offset + 8);

      if (
        end > bytes.length ||
        (offset === 8 && type !== 'IHDR') ||
        ((type.charCodeAt(0) & 0x20) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) ||
        crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
      ) {
        throw new Error('Invalid signature image: corrupt PNG chunk');
      }

      hasIdat ||= type === 'IDAT';
      offset = end;
      if (type === 'IEND') {
        hasIend = length === 0 && end === bytes.length;
        break;
      }
    }

    if (!hasIdat || !hasIend) {
      throw new Error('Invalid signature image: incomplete PNG');
    }
  }

  if (isJpeg && (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)) {
    throw new Error('Invalid signature image: incomplete JPEG');
  }

  // ponytail: decoder warnings also signal corrupt scans that still produce pixels.
  let warning = '';
  await sharp(bytes, { failOn: 'warning', limitInputPixels: 4_000_000 })
    // ponytail: cooperative decoder budget, not a whole-job deadline or RSS watchdog.
    .timeout({ seconds: 5 })
    .on('warning', (message) => {
      warning = message;
    })
    .raw()
    .toBuffer();

  if (warning) {
    throw new Error(`Invalid signature image: ${warning}`);
  }

  return isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
};
