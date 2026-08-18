import { getServerLimits } from '@documenso/ee/server-only/limits/server';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { convertToPdf } from '@documenso/lib/server-only/document-conversion';
import { createEnvelope } from '@documenso/lib/server-only/envelope/create-envelope';
import { insertFormValuesInPdf } from '@documenso/lib/server-only/pdf/insert-form-values-in-pdf';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { EnvelopeType, Prisma } from '@prisma/client';

import { authenticatedProcedure } from '../trpc';
import {
  createDocumentMeta,
  ZCreateDocumentRequestSchema,
  ZCreateDocumentResponseSchema,
} from './create-document.types';

const isIdempotencyKeyUniqueConflict = (error: Prisma.PrismaClientKnownRequestError): boolean => {
  const target = error.meta?.target;

  if (Array.isArray(target)) {
    return target.length === 2 && target.includes('teamId') && target.includes('idempotencyKey');
  }

  if (typeof target === 'string') {
    return target === 'Envelope_teamId_idempotencyKey_key';
  }

  return false;
};

export const createDocumentRoute = authenticatedProcedure
  .meta(createDocumentMeta)
  .input(ZCreateDocumentRequestSchema)
  .output(ZCreateDocumentResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { user, teamId } = ctx;

    const { payload, file } = input;

    const {
      title,
      externalId,
      idempotencyKey,
      visibility,
      globalAccessAuth,
      globalActionAuth,
      recipients,
      meta,
      folderId,
      formValues,
      attachments,
    } = payload;

    if (idempotencyKey) {
      const existingEnvelope = await prisma.envelope.findFirst({
        where: {
          teamId,
          idempotencyKey,
        },
        select: {
          id: true,
          secondaryId: true,
        },
      });

      if (existingEnvelope) {
        return {
          envelopeId: existingEnvelope.id,
          id: mapSecondaryIdToDocumentId(existingEnvelope.secondaryId),
        };
      }
    }

    let pdf = await convertToPdf(file, ctx.logger);

    if (formValues) {
      // eslint-disable-next-line require-atomic-updates
      pdf = await insertFormValuesInPdf({
        pdf,
        formValues,
      });
    }

    const { id: documentDataId } = await putNormalizedPdfFileServerSide({
      name: file.name,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdf),
    });

    ctx.logger.info({
      input: {
        folderId,
      },
    });

    const { remaining } = await getServerLimits({ userId: user.id, teamId });

    if (remaining.documents <= 0) {
      throw new AppError(AppErrorCode.LIMIT_EXCEEDED, {
        message: 'You have reached your document limit for this month. Please upgrade your plan.',
        statusCode: 400,
      });
    }

    try {
      const document = await createEnvelope({
        userId: user.id,
        teamId,
        internalVersion: 1,
        data: {
          type: EnvelopeType.DOCUMENT,
          title,
          externalId,
          idempotencyKey,
          visibility,
          globalAccessAuth,
          globalActionAuth,
          formValues,
          recipients: (recipients || []).map((recipient) => ({
            ...recipient,
            fields: (recipient.fields || []).map((field) => ({
              ...field,
              page: field.pageNumber,
              positionX: field.pageX,
              positionY: field.pageY,
              documentDataId,
            })),
          })),
          folderId,
          envelopeItems: [
            {
              // If you ever allow more than 1 in this endpoint, make sure to use `maximumEnvelopeItemCount` to limit it.
              documentDataId,
            },
          ],
        },
        attachments,
        meta: {
          ...meta,
          emailSettings: meta?.emailSettings ?? undefined,
        },
        requestMetadata: ctx.metadata,
      });

      return {
        envelopeId: document.id,
        id: mapSecondaryIdToDocumentId(document.secondaryId),
      };
    } catch (error) {
      if (
        idempotencyKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        isIdempotencyKeyUniqueConflict(error)
      ) {
        const winningEnvelope = await prisma.envelope.findFirst({
          where: {
            teamId,
            idempotencyKey,
          },
          select: {
            id: true,
            secondaryId: true,
          },
        });

        if (winningEnvelope) {
          return {
            envelopeId: winningEnvelope.id,
            id: mapSecondaryIdToDocumentId(winningEnvelope.secondaryId),
          };
        }
      }

      throw error;
    }
  });
