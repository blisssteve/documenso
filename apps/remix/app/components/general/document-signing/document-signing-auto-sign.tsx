import { DocumentAuth } from '@documenso/lib/types/document-auth';
import { extractInitials } from '@documenso/lib/utils/recipient-formatter';
import { trpc } from '@documenso/trpc/react';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { Field, Recipient } from '@prisma/client';
import { FieldType } from '@prisma/client';
import { useMemo, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

import { useRequiredDocumentSigningAuthContext } from './document-signing-auth-provider';
import { useRequiredDocumentSigningContext } from './document-signing-provider';

// Shared V1 standard and embedded signing control. NAME + INITIALS only —
// DATE/EMAIL/SIGNATURE stay manual. Restricted action auth hides the action.
const NON_AUTO_SIGNABLE_ACTION_AUTH_TYPES: string[] = [
  DocumentAuth.PASSKEY,
  DocumentAuth.PASSWORD,
  DocumentAuth.TWO_FACTOR_AUTH,
];

const AUTO_FILL_FIELD_TYPES: FieldType[] = [FieldType.NAME, FieldType.INITIALS];

export type DocumentSigningAutoSignProps = {
  recipient: Pick<Recipient, 'id' | 'token'>;
  fields: Field[];
};

export const DocumentSigningAutoSign = ({ recipient, fields }: DocumentSigningAutoSignProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();
  const { revalidate } = useRevalidator();

  const { fullName } = useRequiredDocumentSigningContext();
  const { derivedRecipientActionAuth } = useRequiredDocumentSigningAuthContext();

  const [isSubmitting, setIsSubmitting] = useState(false);
  // Close the setState batching window so a rapid double-click cannot enqueue two fan-outs.
  const isSubmittingRef = useRef(false);

  const { mutateAsync: signFieldWithToken } = trpc.field.signFieldWithToken.useMutation();

  const targetFields = useMemo(
    () =>
      fields.filter((field) => {
        if (field.inserted) {
          return false;
        }

        if (!AUTO_FILL_FIELD_TYPES.includes(field.type)) {
          return false;
        }

        return Boolean(fullName);
      }),
    [fields, fullName],
  );

  const actionAuthAllowsAutoFill = derivedRecipientActionAuth.every(
    (actionAuth) => !NON_AUTO_SIGNABLE_ACTION_AUTH_TYPES.includes(actionAuth),
  );

  const visible = actionAuthAllowsAutoFill && targetFields.length > 0;

  const onSubmit = async () => {
    if (isSubmittingRef.current) {
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    try {
      const authOptions = matchActionAuth(derivedRecipientActionAuth.at(0));

      const results = await Promise.allSettled(
        targetFields.map(async (field) => {
          const value = fieldValue(field.type, fullName);

          if (!value) {
            throw new Error('No value to sign');
          }

          return await signFieldWithToken({
            token: recipient.token,
            fieldId: field.id,
            value,
            isBase64: false,
            authOptions,
          });
        }),
      );

      if (results.some((result) => result.status === 'rejected')) {
        toast({
          title: _(msg`Error`),
          description: _(
            msg`An error occurred while filling the document, some fields may not be signed. Please review and manually sign any remaining fields.`,
          ),
          duration: 5000,
          variant: 'destructive',
        });
      }

      await revalidate();
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <Button type="button" className="w-full" loading={isSubmitting} disabled={isSubmitting} onClick={() => onSubmit()}>
      <Trans>Fill Name and Initials ({targetFields.length})</Trans>
    </Button>
  );
};

const fieldValue = (type: FieldType, fullName: string): string => {
  if (type === FieldType.NAME) {
    return fullName;
  }

  if (type === FieldType.INITIALS) {
    return extractInitials(fullName);
  }

  return '';
};

const matchActionAuth = (actionAuth: string | undefined) => {
  if (actionAuth === DocumentAuth.ACCOUNT) {
    return { type: DocumentAuth.ACCOUNT };
  }

  if (actionAuth === DocumentAuth.EXPLICIT_NONE) {
    return { type: DocumentAuth.EXPLICIT_NONE };
  }

  return undefined;
};
