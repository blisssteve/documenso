import { AUTO_SIGNABLE_FIELD_TYPES } from '@documenso/lib/constants/autosign';
import { DocumentAuth, type TRecipientActionAuthTypes } from '@documenso/lib/types/document-auth';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { FieldType, RecipientRole } from '@prisma/client';

export const AUTO_FILL_CONCURRENCY = 8;
export const AUTO_FILL_THRESHOLD = 5;

const NON_AUTO_FILL_ACTION_AUTH_TYPES: string[] = [
  DocumentAuth.PASSKEY,
  DocumentAuth.PASSWORD,
  DocumentAuth.TWO_FACTOR_AUTH,
];

type AutoFillField = {
  id: number;
  inserted: boolean;
  type: FieldType;
};

export const getV2AutoFillFields = <T extends AutoFillField>(fields: T[], fullName: string, email: string): T[] =>
  fields.filter((field) => {
    if (field.inserted || !AUTO_SIGNABLE_FIELD_TYPES.includes(field.type)) {
      return false;
    }

    if ((field.type === FieldType.NAME || field.type === FieldType.INITIALS) && !fullName) {
      return false;
    }

    if (field.type === FieldType.EMAIL && !email) {
      return false;
    }

    return true;
  });

export const getV2AutoFillValue = (fieldType: FieldType, fullName: string, email: string) => {
  if (fieldType === FieldType.NAME) {
    return { type: FieldType.NAME, value: fullName } as const;
  }

  if (fieldType === FieldType.INITIALS) {
    return { type: FieldType.INITIALS, value: extractInitials(fullName) } as const;
  }

  if (fieldType === FieldType.EMAIL) {
    return { type: FieldType.EMAIL, value: email } as const;
  }

  if (fieldType === FieldType.DATE) {
    return { type: FieldType.DATE, value: true } as const;
  }

  throw new Error('Field type is not eligible for automatic filling');
};

export const isV2AutoFillAllowed = (
  recipientRole: RecipientRole,
  actionAuthTypes: TRecipientActionAuthTypes[],
): boolean =>
  recipientRole !== RecipientRole.ASSISTANT &&
  actionAuthTypes.every((authType) => !NON_AUTO_FILL_ACTION_AUTH_TYPES.includes(authType));

export const getV2AutoFillAuthOptions = (actionAuthTypes: TRecipientActionAuthTypes[]) => {
  if (actionAuthTypes.includes(DocumentAuth.ACCOUNT)) {
    return { type: DocumentAuth.ACCOUNT } as const;
  }

  if (actionAuthTypes.includes(DocumentAuth.EXPLICIT_NONE)) {
    return { type: DocumentAuth.EXPLICIT_NONE } as const;
  }

  return undefined;
};

export const shouldPromptForV2AutoFill = (eligibleFieldCount: number, isAllowed: boolean): boolean =>
  isAllowed && eligibleFieldCount > AUTO_FILL_THRESHOLD;

export const mapWithBoundedConcurrency = async <Input, Output>(
  items: Input[],
  concurrency: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer');
  }

  const results: PromiseSettledResult<Output>[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));

  return results;
};

export const mapV2AutoFillWithConsent = <Input, Output>(
  hasConsent: boolean,
  items: Input[],
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> => {
  if (!hasConsent) {
    return Promise.resolve([]);
  }

  return mapWithBoundedConcurrency(items, AUTO_FILL_CONCURRENCY, worker);
};
