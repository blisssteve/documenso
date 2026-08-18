import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrpcContext } from '../context';
import { ZCreateDocumentPayloadSchema } from './create-document.types';

vi.mock('@lingui/core/macro', () => ({
  msg: (str: unknown) => (Array.isArray(str) ? str[0] : str),
}));

const mockConvertToPdf = vi.fn().mockResolvedValue(Buffer.from('pdf-data'));
const mockPutNormalizedPdfFileServerSide = vi.fn().mockResolvedValue({ id: 'doc-data-id-123' });
const mockGetServerLimits = vi.fn().mockResolvedValue({ remaining: { documents: 100 } });
const mockCreateEnvelope = vi.fn();
const mockFindFirst = vi.fn();

vi.mock('@documenso/lib/server-only/document-conversion', () => ({
  convertToPdf: (...args: unknown[]) => mockConvertToPdf(...args),
}));

vi.mock('@documenso/lib/universal/upload/put-file.server', () => ({
  putNormalizedPdfFileServerSide: (...args: unknown[]) => mockPutNormalizedPdfFileServerSide(...args),
}));

vi.mock('@documenso/ee/server-only/limits/server', () => ({
  getServerLimits: (...args: unknown[]) => mockGetServerLimits(...args),
}));

vi.mock('@documenso/lib/server-only/user/assert-user-not-disabled', () => ({
  assertUserNotDisabledById: vi.fn().mockResolvedValue(undefined),
  assertUserNotDisabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@documenso/lib/server-only/envelope/create-envelope', () => ({
  createEnvelope: (...args: unknown[]) => mockCreateEnvelope(...args),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

import { router } from '../trpc';
import { createDocumentRoute } from './create-document';

const testRouter = router({
  createDocument: createDocumentRoute,
});

const createTestCaller = (teamId = 10) => {
  const ctx = {
    user: { id: 1, email: 'user@example.com', name: 'User' },
    teamId,
    session: {},
    req: { headers: new Headers() },
    res: { headers: new Headers() },
    logger: { child: () => ({ info: () => {}, error: () => {} }) },
    metadata: {},
  } as unknown as TrpcContext;

  return testRouter.createCaller(ctx);
};

const createFormData = (payload: object) => {
  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  formData.append('file', new File(['dummy content'], 'document.pdf', { type: 'application/pdf' }));
  return formData;
};

describe('Idempotent document creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockReset();
  });

  describe('Requirement 1: Schema validation', () => {
    it('allows payload without idempotencyKey (backwards compatible)', () => {
      const result = ZCreateDocumentPayloadSchema.safeParse({
        title: 'Test Document',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.idempotencyKey).toBeUndefined();
      }
    });

    it('trims whitespace from idempotencyKey', () => {
      const result = ZCreateDocumentPayloadSchema.safeParse({
        title: 'Test Document',
        idempotencyKey: '   key-123   ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.idempotencyKey).toBe('key-123');
      }
    });

    it('rejects empty string and whitespace-only idempotencyKey', () => {
      const emptyResult = ZCreateDocumentPayloadSchema.safeParse({
        title: 'Test Document',
        idempotencyKey: '',
      });
      expect(emptyResult.success).toBe(false);

      const whitespaceResult = ZCreateDocumentPayloadSchema.safeParse({
        title: 'Test Document',
        idempotencyKey: '     ',
      });
      expect(whitespaceResult.success).toBe(false);
    });

    it('rejects idempotencyKey over 255 characters', () => {
      const longKey = 'a'.repeat(256);
      const result = ZCreateDocumentPayloadSchema.safeParse({
        title: 'Test Document',
        idempotencyKey: longKey,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Requirement 4 & 6: Same-team replay and scoping', () => {
    it('short-circuits before PDF conversion/upload if key exists for team', async () => {
      mockFindFirst.mockResolvedValueOnce({
        id: 'env_existing_123',
        secondaryId: 'document_456',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Test Document',
        idempotencyKey: 'attempt-123',
      });

      const response = await caller.createDocument(formData);

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          teamId: 10,
          idempotencyKey: 'attempt-123',
        },
        select: {
          id: true,
          secondaryId: true,
        },
      });

      expect(mockConvertToPdf).not.toHaveBeenCalled();
      expect(mockPutNormalizedPdfFileServerSide).not.toHaveBeenCalled();
      expect(mockCreateEnvelope).not.toHaveBeenCalled();

      expect(response).toEqual({
        envelopeId: 'env_existing_123',
        id: 456,
      });
    });

    it('does not return an envelope from a different team', async () => {
      // Team 20 looking up key 'attempt-123'
      mockFindFirst.mockResolvedValueOnce(null); // No envelope for Team 20
      mockCreateEnvelope.mockResolvedValueOnce({
        id: 'env_team20_789',
        secondaryId: 'document_999',
      });

      const callerTeam20 = createTestCaller(20);
      const formData = createFormData({
        title: 'Test Document',
        idempotencyKey: 'attempt-123',
      });

      const response = await callerTeam20.createDocument(formData);

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: {
          teamId: 20,
          idempotencyKey: 'attempt-123',
        },
        select: {
          id: true,
          secondaryId: true,
        },
      });

      expect(mockConvertToPdf).toHaveBeenCalled();
      expect(mockCreateEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 20,
          data: expect.objectContaining({
            idempotencyKey: 'attempt-123',
          }),
        }),
      );

      expect(response).toEqual({
        envelopeId: 'env_team20_789',
        id: 999,
      });
    });
  });

  describe('Requirement 5: Race safety & unique conflict handling', () => {
    it('catches matching Prisma P2002 unique conflict and returns winner IDs', async () => {
      mockFindFirst.mockResolvedValueOnce(null); // Precheck passes (no row yet)

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`teamId`,`idempotencyKey`)',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['teamId', 'idempotencyKey'] },
        },
      );

      mockCreateEnvelope.mockRejectedValueOnce(p2002Error);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Race Document',
        idempotencyKey: 'race-key-99',
      });

      const response = await caller.createDocument(formData);

      expect(response).toEqual({
        envelopeId: 'env_winner_555',
        id: 666,
      });

      expect(mockFindFirst).toHaveBeenLastCalledWith({
        where: {
          teamId: 10,
          idempotencyKey: 'race-key-99',
        },
        select: {
          id: true,
          secondaryId: true,
        },
      });
    });

    it('rethrows unrelated P2002 unique conflict errors', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const unrelatedP2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on secondaryId', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['secondaryId'] },
      });

      mockCreateEnvelope.mockRejectedValueOnce(unrelatedP2002);

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Conflict Document',
        idempotencyKey: 'key-123',
      });

      await expect(caller.createDocument(formData)).rejects.toThrow();
    });

    it('catches matching Prisma P2002 exact string target conflict', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on constraint Envelope_teamId_idempotencyKey_key',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: 'Envelope_teamId_idempotencyKey_key' },
        },
      );

      mockCreateEnvelope.mockRejectedValueOnce(p2002Error);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Race Document',
        idempotencyKey: 'race-key-99',
      });

      const response = await caller.createDocument(formData);

      expect(response).toEqual({
        envelopeId: 'env_winner_555',
        id: 666,
      });
    });

    it('catches matching Prisma P2002 array target conflict in reverse order', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`idempotencyKey`,`teamId`)',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['idempotencyKey', 'teamId'] },
        },
      );

      mockCreateEnvelope.mockRejectedValueOnce(p2002Error);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Race Document',
        idempotencyKey: 'race-key-99',
      });

      const response = await caller.createDocument(formData);

      expect(response).toEqual({
        envelopeId: 'env_winner_555',
        id: 666,
      });
    });

    it('rethrows near-match array target containing idempotencyKey without teamId', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const nearMatchError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on idempotencyKey', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['idempotencyKey'] },
      });

      mockCreateEnvelope.mockRejectedValueOnce(nearMatchError);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Near Match Document',
        idempotencyKey: 'key-123',
      });

      await expect(caller.createDocument(formData)).rejects.toThrow();
    });

    it('rethrows near-match array target with extra fields', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const nearMatchError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on externalId, idempotencyKey',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: ['externalId', 'idempotencyKey'] },
        },
      );

      mockCreateEnvelope.mockRejectedValueOnce(nearMatchError);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Near Match Document',
        idempotencyKey: 'key-123',
      });

      await expect(caller.createDocument(formData)).rejects.toThrow();
    });

    it('rethrows near-match string target', async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const nearMatchError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on Envelope_idempotencyKey_key',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { target: 'Envelope_idempotencyKey_key' },
        },
      );

      mockCreateEnvelope.mockRejectedValueOnce(nearMatchError);

      mockFindFirst.mockResolvedValueOnce({
        id: 'env_winner_555',
        secondaryId: 'document_666',
      });

      const caller = createTestCaller(10);
      const formData = createFormData({
        title: 'Near Match Document',
        idempotencyKey: 'key-123',
      });

      await expect(caller.createDocument(formData)).rejects.toThrow();
    });
  });
});
