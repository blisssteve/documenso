import {
  getV2AutoFillAuthOptions,
  getV2AutoFillFields,
  getV2AutoFillValue,
  isV2AutoFillAllowed,
  mapV2AutoFill,
  shouldPromptForV2AutoFill,
} from '@documenso/lib/client-only/v2-embed-auto-fill';
import { AUTO_SIGNABLE_FIELD_TYPES } from '@documenso/lib/constants/autosign';
import { Button } from '@documenso/ui/primitives/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@documenso/ui/primitives/dialog';
import { FRIENDLY_FIELD_TYPE } from '@documenso/ui/primitives/document-flow/types';
import { useLingui } from '@lingui/react';
import { Plural, Trans } from '@lingui/react/macro';
import type { FieldType } from '@prisma/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRequiredDocumentSigningAuthContext } from './document-signing-auth-provider';
import { DocumentSigningDisclosure } from './document-signing-disclosure';
import { useRequiredEnvelopeSigningContext } from './envelope-signing-provider';

export const DocumentSigningAutoFillV2 = () => {
  const { _ } = useLingui();
  const { derivedRecipientActionAuth } = useRequiredDocumentSigningAuthContext();
  const { email, fullName, recipient, recipientFields, signField } = useRequiredEnvelopeSigningContext();

  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failedFieldIds, setFailedFieldIds] = useState<number[] | null>(null);
  const hasPrompted = useRef(false);

  const eligibleFields = useMemo(
    () => getV2AutoFillFields(recipientFields, fullName, email),
    [recipientFields, fullName, email],
  );
  const isAllowed = isV2AutoFillAllowed(recipient.role, derivedRecipientActionAuth);
  const targetFields = failedFieldIds
    ? eligibleFields.filter((field) => failedFieldIds.includes(field.id))
    : eligibleFields;

  useEffect(() => {
    if (hasPrompted.current) {
      return;
    }

    hasPrompted.current = true;

    if (shouldPromptForV2AutoFill(eligibleFields.length, isAllowed)) {
      setOpen(true);
    }
  }, [eligibleFields.length, isAllowed]);

  const onSubmit = async () => {
    setIsSubmitting(true);

    try {
      const authOptions = getV2AutoFillAuthOptions(derivedRecipientActionAuth);
      const results = await mapV2AutoFill(targetFields, async (field) =>
        signField(field.id, getV2AutoFillValue(field.type, fullName, email), authOptions),
      );
      const failures = targetFields.filter((_field, index) => results[index].status === 'rejected');

      if (failures.length === 0) {
        setOpen(false);
        return;
      }

      setFailedFieldIds(failures.map((field) => field.id));
    } finally {
      setIsSubmitting(false);
    }
  };

  const onCancel = () => {
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isSubmitting && setOpen(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Automatically sign fields</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="max-w-[50ch] text-muted-foreground">
          <p>
            <Trans>
              When you sign a document, we can automatically fill in and sign the following fields using information
              that has already been provided. You can also manually sign or remove any automatically signed fields
              afterwards if you desire.
            </Trans>
          </p>

          <ul className="mt-4 flex list-inside list-disc flex-col gap-y-0.5">
            {AUTO_SIGNABLE_FIELD_TYPES.map((fieldType) => (
              <li key={fieldType}>
                <Trans>{_(FRIENDLY_FIELD_TYPE[fieldType as FieldType])}</Trans>
                <span className="pl-2 text-sm">
                  (
                  <Plural
                    value={targetFields.filter((field) => field.type === fieldType).length}
                    one="1 matching field"
                    other="# matching fields"
                  />
                  )
                </span>
              </li>
            ))}
          </ul>

          {failedFieldIds && (
            <p className="mt-4 text-destructive" role="alert">
              <Plural
                value={targetFields.length}
                one="1 field could not be filled. The successful fields were kept; retry the remaining field or fill it manually."
                other="# fields could not be filled. The successful fields were kept; retry the remaining fields or fill them manually."
              />
            </p>
          )}
        </div>

        <DocumentSigningDisclosure className="mt-4" />

        <DialogFooter className="flex w-full flex-1 flex-nowrap gap-2">
          <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>

          <Button
            type="button"
            className="min-w-[6rem]"
            loading={isSubmitting}
            disabled={!targetFields.length}
            onClick={() => void onSubmit()}
          >
            {failedFieldIds ? <Trans>Retry remaining</Trans> : <Trans>Sign</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
