import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import { FieldType } from '@prisma/client';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64')}`;

type ActionAuthOptions = {
  onReauthFormSubmit: (authOptions?: TRecipientActionAuth) => Promise<void> | void;
  actionTarget: FieldType;
};

const harness = vi.hoisted(() => ({
  executeActionAuthProcedure: vi.fn(async (options: ActionAuthOptions) => {
    await options.onReauthFormSubmit();
  }),
  hookIndex: 0,
  hookState: [] as unknown[],
  providedSignature: null as string | null,
  revalidate: vi.fn().mockResolvedValue(undefined),
  setProvidedSignature: vi.fn(),
  signFieldWithToken: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));

vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');

  return {
    ...react,
    useLayoutEffect: () => undefined,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(initialValue: T) => {
      const index = harness.hookIndex++;
      harness.hookState[index] ??= { current: initialValue };
      return harness.hookState[index] as { current: T };
    },
    useState: <T>(initialValue: T) => {
      const index = harness.hookIndex++;
      harness.hookState[index] ??= initialValue;

      return [
        harness.hookState[index] as T,
        (value: T | ((current: T) => T)) => {
          harness.hookState[index] =
            typeof value === 'function' ? (value as (current: T) => T)(harness.hookState[index] as T) : value;
        },
      ];
    },
  };
});

vi.mock('@documenso/lib/client-only/hooks/use-analytics', () => ({
  useAnalytics: () => ({ captureException: vi.fn() }),
}));
vi.mock('@documenso/trpc/react', () => ({
  trpc: {
    field: {
      signFieldWithToken: {
        useMutation: () => ({ mutateAsync: harness.signFieldWithToken, isPending: false }),
      },
      removeSignedFieldWithToken: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
  },
}));
vi.mock('@documenso/ui/primitives/button', () => ({ Button: 'button' }));
vi.mock('@documenso/ui/primitives/dialog', () => ({
  Dialog: 'dialog',
  DialogContent: 'dialog-content',
  DialogFooter: 'dialog-footer',
  DialogTitle: 'dialog-title',
}));
vi.mock('@documenso/ui/primitives/signature-pad', () => ({ SignaturePad: 'signature-pad' }));
vi.mock('@documenso/ui/primitives/use-toast', () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock('@lingui/core/macro', () => ({ msg: (value: string) => value }));
vi.mock('@lingui/react', () => ({ Trans: 'trans', useLingui: () => ({ _: (value: string) => value }) }));
vi.mock('@lingui/react/macro', () => ({ Trans: 'trans' }));
vi.mock('lucide-react', () => ({ Loader: 'loader' }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: harness.revalidate }) }));
vi.mock('~/components/general/document-signing/document-signing-disclosure', () => ({
  DocumentSigningDisclosure: 'disclosure',
}));
vi.mock('./document-signing-auth-provider', () => ({
  useRequiredDocumentSigningAuthContext: () => ({
    executeActionAuthProcedure: harness.executeActionAuthProcedure,
  }),
}));
vi.mock('./document-signing-field-container', () => ({
  DocumentSigningFieldContainer: 'field-container',
}));
vi.mock('./document-signing-provider', () => ({
  useRequiredDocumentSigningContext: () => ({
    fullName: 'Dr Vet',
    signature: harness.providedSignature,
    setSignature: harness.setProvidedSignature,
  }),
}));
vi.mock('./document-signing-recipient-provider', () => ({
  useDocumentSigningRecipientContext: () => ({
    recipient: { id: 1, name: 'Dr Vet', email: 'vet@example.com', token: 'token-123' },
  }),
}));

import {
  DocumentSigningSignatureField,
  type DocumentSigningSignatureFieldProps,
} from './document-signing-signature-field';

const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }

  if (!node || typeof node !== 'object' || !('props' in node)) {
    return [];
  }

  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
};

const baseField = {
  id: 42,
  type: FieldType.SIGNATURE,
  inserted: false,
  recipientId: 1,
  signature: null,
} as unknown as DocumentSigningSignatureFieldProps['field'];

const renderField = (overrides: Partial<DocumentSigningSignatureFieldProps> = {}) => {
  harness.hookIndex = 0;

  return DocumentSigningSignatureField({
    field: baseField,
    ...overrides,
  }) as ReactElement;
};

const getSignButton = (view: ReactElement) =>
  elements(view).find((el) => el.type === 'button' && 'disabled' in el.props) as
    | ReactElement<{ onClick: () => Promise<void> | void; disabled?: boolean }>
    | undefined;

const getSignaturePad = (view: ReactElement) =>
  elements(view).find((el) => el.type === 'signature-pad') as
    | ReactElement<{ onChange: (v: { value: string }) => void }>
    | undefined;

describe('DocumentSigningSignatureField acknowledged-state publication', () => {
  beforeEach(() => {
    harness.executeActionAuthProcedure = vi.fn(async (options: ActionAuthOptions) => {
      await options.onReauthFormSubmit();
    });
    harness.hookIndex = 0;
    harness.hookState = [];
    harness.providedSignature = null;
    harness.revalidate = vi.fn().mockResolvedValue(undefined);
    harness.setProvidedSignature = vi.fn();
    harness.signFieldWithToken = vi.fn().mockResolvedValue(undefined);
    harness.toast = vi.fn();
  });

  it('does not publish state or persistence when action auth is cancelled', async () => {
    const onSignatureChanged = vi.fn();
    const onSignField = vi.fn();
    harness.executeActionAuthProcedure = vi.fn().mockResolvedValue(undefined);

    getSignaturePad(renderField({ onSignField, onSignatureChanged }))?.props.onChange({
      value: PNG_DATA_URL,
    });
    await getSignButton(renderField({ onSignField, onSignatureChanged }))?.props.onClick();

    expect(harness.executeActionAuthProcedure).toHaveBeenCalledTimes(1);
    expect(onSignField).not.toHaveBeenCalled();
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();
  });

  it('does not swallow UNAUTHORIZED auth errors and does not publish state', async () => {
    const onSignatureChanged = vi.fn();
    const onSignField = vi.fn().mockRejectedValue(new AppError(AppErrorCode.UNAUTHORIZED));
    let capturedAuthPromise: Promise<void> | undefined;

    harness.executeActionAuthProcedure = vi.fn((options: ActionAuthOptions) => {
      capturedAuthPromise = Promise.resolve(options.onReauthFormSubmit({ type: 'PASSWORD', password: 'wrong' }));
      return capturedAuthPromise;
    });

    getSignaturePad(renderField({ onSignField, onSignatureChanged }))?.props.onChange({
      value: PNG_DATA_URL,
    });
    getSignButton(renderField({ onSignField, onSignatureChanged }))?.props.onClick();

    await expect(capturedAuthPromise).rejects.toThrow();
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('does not publish state or persistence when field mutation rejects', async () => {
    const onSignatureChanged = vi.fn();
    const onSignField = vi.fn().mockRejectedValue(new Error('network failure'));

    getSignaturePad(renderField({ onSignField, onSignatureChanged }))?.props.onChange({
      value: PNG_DATA_URL,
    });
    await getSignButton(renderField({ onSignField, onSignatureChanged }))?.props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSignField).toHaveBeenCalledTimes(1);
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();
    expect(harness.revalidate).not.toHaveBeenCalled();
  });

  it('does not publish state when no signature is provided or when typed signature is disabled', async () => {
    const onSignatureChanged = vi.fn();
    const onSignField = vi.fn();

    await getSignButton(renderField({ onSignField, onSignatureChanged }))?.props.onClick();
    expect(harness.executeActionAuthProcedure).not.toHaveBeenCalled();
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();

    getSignaturePad(renderField({ onSignField, onSignatureChanged, typedSignatureEnabled: false }))?.props.onChange({
      value: 'Dr Vet',
    });
    await getSignButton(
      renderField({ onSignField, onSignatureChanged, typedSignatureEnabled: false }),
    )?.props.onClick();
    await Promise.resolve();

    expect(onSignField).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();
  });

  it('publishes setProvidedSignature and onSignatureChanged only after onSignField resolves', async () => {
    const onSignatureChanged = vi.fn();
    let resolveSign!: () => void;
    const onSignField = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSign = resolve;
        }),
    );

    getSignaturePad(renderField({ onSignField, onSignatureChanged }))?.props.onChange({
      value: PNG_DATA_URL,
    });
    getSignButton(renderField({ onSignField, onSignatureChanged }))?.props.onClick();
    await Promise.resolve();

    expect(onSignField).toHaveBeenCalledTimes(1);
    expect(harness.setProvidedSignature).not.toHaveBeenCalled();
    expect(onSignatureChanged).not.toHaveBeenCalled();

    resolveSign();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.setProvidedSignature).toHaveBeenCalledWith(PNG_DATA_URL);
    expect(onSignatureChanged).toHaveBeenCalledWith(PNG_DATA_URL);
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
  });

  it('publishes after default signFieldWithToken resolves and preserves explicit manual sign with prefilled signature', async () => {
    const onSignatureChanged = vi.fn();

    getSignaturePad(renderField({ onSignatureChanged }))?.props.onChange({
      value: PNG_DATA_URL,
    });
    getSignButton(renderField({ onSignatureChanged }))?.props.onClick();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.signFieldWithToken).toHaveBeenCalledWith({
      token: 'token-123',
      fieldId: 42,
      value: PNG_DATA_URL,
      isBase64: true,
      authOptions: undefined,
    });
    expect(harness.setProvidedSignature).toHaveBeenCalledWith(PNG_DATA_URL);
    expect(onSignatureChanged).toHaveBeenCalledWith(PNG_DATA_URL);

    // Positive control: explicit manual click with prefilled providedSignature
    harness.hookState = [];
    harness.providedSignature = PNG_DATA_URL;
    harness.signFieldWithToken.mockClear();
    const onSignField = vi.fn().mockResolvedValue(undefined);
    const container = elements(renderField({ onSignField })).find((el) => el.type === 'field-container') as
      | ReactElement<{ onPreSign: () => boolean; onSign: () => Promise<void> }>
      | undefined;
    expect(container?.props.onPreSign()).toBe(true);
    await container?.props.onSign();
    expect(onSignField).toHaveBeenCalledWith({
      token: 'token-123',
      fieldId: 42,
      value: PNG_DATA_URL,
      isBase64: true,
      authOptions: undefined,
    });
  });
});
