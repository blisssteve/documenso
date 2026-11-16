import { readFileSync } from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';
import { PDFArray, PDFContentStream, PDFDict, PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';
import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import { FieldType, Prisma } from '@prisma/client';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { insertFieldInPDFV1 } from './insert-field-in-pdf-v1';
import { legacy_insertFieldInPDF } from './legacy-insert-field-in-pdf';

// Synthetic 8x4 solid-colour images, never customer signatures.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFElEQVR42mOUMEhgwAaYGHAA0iUAQfwAsIm/ytcAAAAASUVORK5CYII=';
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD//gAVc3ludGhldGljIHNpZ25hdHVyZf/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAQACAMBIgACEQEDEQH/xAAVAAEBAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJaAsgv/2Q==';

const fonts = new Map([
  ['/fonts/caveat.ttf', readFileSync(new URL('../../../../apps/remix/public/fonts/caveat.ttf', import.meta.url))],
  ['/fonts/noto-sans.ttf', readFileSync(new URL('../../../../apps/remix/public/fonts/noto-sans.ttf', import.meta.url))],
]);

const makeField = (
  type: FieldType,
  signatureImageAsBase64: string | null,
  typedSignature: string | null = null,
): FieldWithSignature => ({
  id: 1,
  secondaryId: 'synthetic-signature',
  envelopeId: 'synthetic-envelope',
  envelopeItemId: 'synthetic-item',
  recipientId: 1,
  type,
  page: 1,
  positionX: new Prisma.Decimal(10),
  positionY: new Prisma.Decimal(20),
  width: new Prisma.Decimal(30),
  height: new Prisma.Decimal(10),
  customText: '',
  inserted: true,
  fieldMeta: null,
  signature: {
    id: 1,
    created: new Date('2026-01-01T00:00:00Z'),
    recipientId: 1,
    fieldId: 1,
    signatureImageAsBase64,
    typedSignature,
  },
});

const getDrawnContent = (pdf: PDFDocument) => {
  const contents = pdf.getPages()[0].node.Contents();

  if (!contents) {
    return '';
  }

  expect(contents).toBeInstanceOf(PDFArray);

  if (!(contents instanceof PDFArray)) {
    throw new Error('Expected page content array');
  }

  return contents
    .asArray()
    .map((ref) => {
      const stream = pdf.context.lookup(ref);
      expect(stream).toBeInstanceOf(PDFContentStream);

      if (!(stream instanceof PDFContentStream)) {
        throw new Error('Expected drawn content stream');
      }

      return stream.getContentsString();
    })
    .join('\n');
};

const pngChunk = (type: string, data: Buffer, corruptCrc = false) => {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  if (corruptCrc) {
    chunk[chunk.length - 1] ^= 1;
  }
  return chunk;
};

const pngBytes = Buffer.from(PNG_BASE64, 'base64');
const idatOffset = pngBytes.indexOf(Buffer.from('IDAT')) - 4;
const pngHeader = pngBytes.subarray(0, idatOffset);
const pngEnd = pngBytes.subarray(-12);
const idatData = pngBytes.subarray(idatOffset + 8, -16);
const ancillaryChunk = pngChunk('tEXt', Buffer.from('Comment\0synthetic signature'));
const ancillaryPng = Buffer.concat([pngHeader, ancillaryChunk, pngBytes.subarray(idatOffset)]);

const imageCases = [
  { name: 'PNG with valid ancillary tEXt chunk', value: ancillaryPng.toString('base64'), filter: '/FlateDecode' },
  { name: 'JPEG data URL', value: `data:image/jpeg;base64,${JPEG_BASE64}`, filter: '/DCTDecode' },
  { name: 'bare JPEG base64', value: JPEG_BASE64, filter: '/DCTDecode' },
  { name: 'PNG data URL', value: `data:image/png;base64,${PNG_BASE64}`, filter: '/FlateDecode' },
  { name: 'bare PNG base64', value: PNG_BASE64, filter: '/FlateDecode' },
  { name: 'JPEG mislabeled as PNG', value: `data:image/png;base64,${JPEG_BASE64}`, filter: '/DCTDecode' },
  { name: 'PNG mislabeled as JPEG', value: `data:image/jpeg;base64,${PNG_BASE64}`, filter: '/FlateDecode' },
  {
    name: 'permissive JPEG data URL with parameters and whitespace',
    value: ` DATA:image/jpeg;charset=utf-8;BASE64,\n${JPEG_BASE64}\n `,
    filter: '/DCTDecode',
  },
  { name: 'data URL with omitted MIME', value: `data:;base64,${PNG_BASE64}`, filter: '/FlateDecode' },
  { name: 'unpadded JPEG base64', value: JPEG_BASE64.replace(/=+$/, ''), filter: '/DCTDecode' },
];

const badCrcPng = Buffer.from(PNG_BASE64, 'base64');
badCrcPng[29] ^= 1;

const jpegBytes = Buffer.from(JPEG_BASE64, 'base64');
const sofOffset = jpegBytes.indexOf(Buffer.from([0xff, 0xc0]));
const truncatedSofJpeg = Buffer.concat([
  jpegBytes.subarray(0, sofOffset + 2 + jpegBytes.readUInt16BE(sofOffset + 2)),
  Buffer.from([0xff, 0xd9]),
]);

const sosOffset = jpegBytes.indexOf(Buffer.from([0xff, 0xda]));
const scanOffset = sosOffset + 2 + jpegBytes.readUInt16BE(sosOffset + 2);
const jpegWithScan = (scan: Buffer) =>
  Buffer.concat([jpegBytes.subarray(0, scanOffset), scan, Buffer.from([0xff, 0xd9])]).toString('base64');

const invalidCases = [
  {
    name: 'PNG with corrupt IDAT CRC',
    value: Buffer.concat([pngHeader, pngChunk('IDAT', idatData, true), pngEnd]).toString('base64'),
  },
  {
    name: 'PNG with corrupt ancillary tEXt CRC',
    value: Buffer.concat([
      pngHeader,
      pngChunk('tEXt', Buffer.from('Comment\0synthetic signature'), true),
      pngBytes.subarray(idatOffset),
    ]).toString('base64'),
  },
  ...[false, true].map((corruptCrc) => ({
    name: `PNG with unknown critical ABCD chunk and ${corruptCrc ? 'bad' : 'valid'} CRC`,
    value: Buffer.concat([
      pngHeader,
      pngChunk('ABCD', Buffer.from('synthetic'), corruptCrc),
      pngBytes.subarray(idatOffset),
    ]).toString('base64'),
  })),
  {
    name: 'PNG with forged IEND after incomplete IDAT',
    value: Buffer.concat([pngHeader, pngBytes.subarray(idatOffset, idatOffset + 10), pngEnd]).toString('base64'),
  },
  {
    name: 'PNG with corrupt IDAT deflate stream and valid CRC',
    value: Buffer.concat([pngHeader, pngChunk('IDAT', Buffer.alloc(idatData.length, 0xff)), pngEnd]).toString('base64'),
  },
  { name: 'SOS-present JPEG with zero entropy bytes', value: jpegWithScan(Buffer.alloc(0)) },
  {
    name: 'SOS-present JPEG with one partial entropy byte',
    value: jpegWithScan(jpegBytes.subarray(scanOffset, scanOffset + 1)),
  },
  { name: 'SOS-present JPEG with invalid scan data', value: jpegWithScan(Buffer.from([0xff, 0x01, 0xff, 0x01])) },
  { name: 'SOS-present JPEG with invalid scan marker', value: jpegWithScan(Buffer.from([0xff, 0xc4, 0xff, 0xff])) },
  {
    name: 'JPEG with trailing bytes after EOI',
    value: Buffer.concat([jpegBytes, Buffer.from('trailing')]).toString('base64'),
  },
  { name: 'PNG with corrupted IHDR CRC', value: badCrcPng.toString('base64') },
  {
    name: 'header-only JPEG with SOF and EOI but no SOS scan',
    value: Buffer.from('ffd8ffc00011080004000803011100021100031100ffd9', 'hex').toString('base64'),
  },
  { name: 'JPEG truncated after SOF with EOI appended', value: truncatedSofJpeg.toString('base64') },
  { name: 'SVG', value: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', unsupported: true },
  { name: 'GIF', value: 'data:image/gif;base64,R0lGODlh', unsupported: true },
  { name: 'unknown bytes', value: Buffer.from('not an image').toString('base64'), unsupported: true },
  { name: 'truncated PNG', value: Buffer.from(PNG_BASE64, 'base64').subarray(0, 8).toString('base64') },
  { name: 'PNG missing its end chunk', value: Buffer.from(PNG_BASE64, 'base64').subarray(0, -12).toString('base64') },
  { name: 'JPEG missing its end marker', value: Buffer.from(JPEG_BASE64, 'base64').subarray(0, -2).toString('base64') },
  { name: 'truncated JPEG', value: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
  { name: 'corrupt JPEG', value: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]).toString('base64') },
  { name: 'invalid base64 characters', value: 'data:image/png;base64,%%%' },
  { name: 'invalid character appended to valid PNG', value: `${PNG_BASE64}!` },
  { name: 'invalid base64 length', value: 'A' },
  { name: 'excess padding', value: `${JPEG_BASE64}=` },
  { name: 'noncanonical padding bits', value: `${PNG_BASE64.slice(0, -2)}J=` },
  { name: 'empty base64', value: '' },
  { name: 'whitespace-only base64', value: ' \n ' },
  { name: 'empty data URL payload', value: 'data:image/png;base64,' },
];

beforeEach(() => {
  // ponytail: replace only font transport; PDF, image parsing and drawing remain real.
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const font = fonts.get(new URL(String(input)).pathname);

    if (!font) {
      throw new Error(`Unexpected font request: ${String(input)}`);
    }

    return Promise.resolve(new Response(new Uint8Array(font)));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  ['V1', insertFieldInPDFV1],
  ['legacy V1', legacy_insertFieldInPDF],
] as const)('%s signature insertion', (_name, insertField) => {
  describe.each([FieldType.SIGNATURE, FieldType.FREE_SIGNATURE])('%s', (type) => {
    it.each(imageCases)('draws and round-trips $name using the byte-selected image format', async ({
      value,
      filter,
    }) => {
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);

      expect(await insertField(pdf, makeField(type, value))).toBe(pdf);
      expect(getDrawnContent(pdf)).toMatch(/\/Image-\S+ Do/);

      const reloaded = await PDFDocument.load(await pdf.save());
      expect(reloaded.getPageCount()).toBe(1);

      const images = reloaded.getPages()[0].node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      expect(images?.keys()).toHaveLength(1);
      const image = images?.lookup(images.keys()[0], PDFStream);
      expect(image?.dict.lookup(PDFName.of('Subtype'), PDFName).toString()).toBe('/Image');
      expect(image?.dict.lookup(PDFName.of('Filter'), PDFName).toString()).toBe(filter);
    });

    it('accepts exactly 5 MiB of original decoded image bytes', async () => {
      // JPEG APP15 segments pad the original image without increasing its raster.
      const segments = [jpegBytes.subarray(0, 2)];
      let remaining = 5_242_880 - jpegBytes.length;
      while (remaining > 0) {
        const size = Math.min(remaining, 65_537);
        const segment = Buffer.alloc(size);
        segment.writeUInt16BE(0xffef);
        segment.writeUInt16BE(size - 2, 2);
        segments.push(segment);
        remaining -= size;
      }
      const bytes = Buffer.concat([...segments, jpegBytes.subarray(2)]);
      expect(bytes.length).toBe(5_242_880);
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const embed = vi.spyOn(pdf, 'embedJpg');
      await insertField(pdf, makeField(type, ` data:image/png;base64,\n${bytes.toString('base64')}\n `));
      expect((embed.mock.calls[0][0] as Buffer).equals(bytes)).toBe(true);
      expect(getDrawnContent(pdf)).toContain(' Do');
      expect((await PDFDocument.load(await pdf.save())).getPageCount()).toBe(1);
    });

    it.each([false, true])('rejects one decoded byte over 5 MiB before allocation (unpadded: %s)', async (unpadded) => {
      const value = Buffer.alloc(5_242_881).toString('base64');
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const from = vi.spyOn(Buffer, 'from');
      const embedPng = vi.spyOn(pdf, 'embedPng');
      const embedJpg = vi.spyOn(pdf, 'embedJpg');
      try {
        await expect(insertField(pdf, makeField(type, unpadded ? value.replace(/=+$/, '') : value))).rejects.toThrow(
          'Signature image exceeds 5242880 decoded bytes',
        );
        expect(from.mock.calls.some((args: unknown[]) => args[1] === 'base64')).toBe(false);
        expect(embedPng).not.toHaveBeenCalled();
        expect(embedJpg).not.toHaveBeenCalled();
        expect(getDrawnContent(pdf)).toBe('');
      } finally {
        from.mockRestore();
      }
    });

    it('accepts exactly 4000000 pixels without changing original JPEG bytes', async () => {
      const bytes = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#808080' } })
        .jpeg()
        .toBuffer();
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const embed = vi.spyOn(pdf, 'embedJpg');
      await insertField(pdf, makeField(type, bytes.toString('base64')));
      expect((embed.mock.calls[0][0] as Buffer).equals(bytes)).toBe(true);
      expect(getDrawnContent(pdf)).toContain(' Do');
      const reloaded = await PDFDocument.load(await pdf.save());
      const images = reloaded.getPages()[0].node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      const image = images?.lookup(images.keys()[0], PDFStream);
      expect(image?.dict.lookup(PDFName.of('Width'))?.toString()).toBe('2000');
      expect(image?.dict.lookup(PDFName.of('Height'))?.toString()).toBe('2000');
      expect(Buffer.from(image?.getContents() ?? [])).toEqual(bytes);
    });

    it.each([
      '4000001 pixels',
      'original 8192-square JPEG',
    ])('rejects %s before a full raw raster or PDF image is returned', async (name) => {
      const bytes =
        name === '4000001 pixels'
          ? await sharp({ create: { width: 41, height: 97561, channels: 3, background: '#808080' } })
              .png()
              .toBuffer()
          : inflateSync(
              Buffer.from(
                'eJztzb1Kw2AYhuHvM2BDYkMCKh0qbaMtLUJVKBSJRqQOetYOHoQ/BxPt4lC7uF/XeL/wvN179xU2Iev10t5hlqZpnmV5MSiLfr84OzmtBuej6UU9qiezy/XVbLFaTOrrx5vVbdO27XT59LK5e17ft812JGZ5XvSLYVkOm3k9b/6tew1VOg7jkMQ6HFQxqWL3Fo5DDDu2tdxb495a/a2f4SiJP0+SKjzsHgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH51H9++sSma',
                'base64',
              ),
            );
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const png = vi.spyOn(pdf, 'embedPng');
      const jpg = vi.spyOn(pdf, 'embedJpg');
      await expect(insertField(pdf, makeField(type, bytes.toString('base64'), 'Never substitute'))).rejects.toThrow(
        'Input image exceeds pixel limit',
      );
      expect(png).not.toHaveBeenCalled();
      expect(jpg).not.toHaveBeenCalled();
      expect(getDrawnContent(pdf)).toBe('');
    });

    it('wires the native five-second decoder timeout and propagates its failure', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const timeout = vi.spyOn(sharp.prototype, 'timeout');
      const toBuffer = vi
        .spyOn(sharp.prototype, 'toBuffer')
        .mockRejectedValueOnce(new Error('synthetic native decoder timeout'));
      const embed = vi.spyOn(pdf, 'embedJpg');
      try {
        await expect(insertField(pdf, makeField(type, JPEG_BASE64, 'Never substitute'))).rejects.toThrow(
          'synthetic native decoder timeout',
        );
        expect(timeout).toHaveBeenCalledWith({ seconds: 5 });
        expect(embed).not.toHaveBeenCalled();
        expect(getDrawnContent(pdf)).toBe('');
      } finally {
        timeout.mockRestore();
        toBuffer.mockRestore();
      }
    });

    it('keeps typed-signature fallback when the image is null', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);

      await insertField(pdf, makeField(type, null, 'Dr Test'));

      const content = getDrawnContent(pdf);
      expect(content).toMatch(/<[0-9a-f]+> Tj/i);
      expect(content).not.toContain(' Do');
      expect((await PDFDocument.load(await pdf.save())).getPageCount()).toBe(1);
    });

    it.each(invalidCases)('throws an Error rather than omitting $name', async ({ value, unsupported }) => {
      const pdf = await PDFDocument.create();
      pdf.addPage([600, 800]);
      const insertion = insertField(pdf, makeField(type, value)).then(() => undefined);

      await expect(insertion).rejects.toBeInstanceOf(Error);

      if (unsupported) {
        await expect(insertion).rejects.toThrow('Unsupported signature image format: expected PNG or JPEG');
      }

      expect(getDrawnContent(pdf)).toBe('');
    });
  });
});
