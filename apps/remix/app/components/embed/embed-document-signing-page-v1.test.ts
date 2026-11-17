import { SigningStatus } from '@prisma/client';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64')}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString('base64')}`;

const encodeHash = (payload: Record<string, unknown>) => `#${btoa(encodeURIComponent(JSON.stringify(payload)))}`;

const harness = vi.hoisted(() => ({
  completeDocumentWithToken: vi.fn().mockResolvedValue({ status: 'OK' }),
  email: '',
  fullName: '',
  hookIndex: 0,
  hookState: [] as unknown[],
  injectCss: vi.fn(),
  layoutRan: false,
  persistSignature: vi.fn(),
  postMessage: vi.fn(),
  setEmail: vi.fn(),
  setFullName: vi.fn(),
  setSignature: vi.fn(),
  signature: null as string | null,
  toast: vi.fn(),
}));

vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');

  return {
    ...react,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: () => undefined,
    useId: () => 'test-id',
    useLayoutEffect: (fn: () => void) => {
      if (!harness.layoutRan) {
        harness.layoutRan = true;
        fn();
      }
    },
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
vi.mock('@documenso/lib/client-only/hooks/use-throttle-fn', () => ({
  useThrottleFn: <T extends (...args: never[]) => unknown>(fn: T) => [fn, false],
}));
vi.mock('@documenso/lib/utils/envelope-download', () => ({
  getDocumentDataUrlForPdfViewer: () => 'https://example.com/doc.pdf',
}));
vi.mock('@documenso/lib/utils/i18n', () => ({
  dynamicActivate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@documenso/trpc/react', () => ({
  trpc: {
    recipient: {
      completeDocumentWithToken: {
        useMutation: () => ({
          mutateAsync: harness.completeDocumentWithToken,
          isPending: false,
        }),
      },
    },
  },
}));
vi.mock('@documenso/ui/components/document/document-read-only-fields', () => ({
  DocumentReadOnlyFields: 'document-read-only-fields',
}));
vi.mock('@documenso/ui/components/field/field-tooltip', () => ({ FieldToolTip: 'field-tooltip' }));
vi.mock('@documenso/ui/primitives/button', () => ({ Button: 'button' }));
vi.mock('@documenso/ui/primitives/element-visible', () => ({ ElementVisible: 'element-visible' }));
vi.mock('@documenso/ui/primitives/input', () => ({ Input: 'input' }));
vi.mock('@documenso/ui/primitives/label', () => ({ Label: 'label' }));
vi.mock('@documenso/ui/primitives/radio-group', () => ({
  RadioGroup: 'radio-group',
  RadioGroupItem: 'radio-group-item',
}));
vi.mock('@documenso/ui/primitives/signature-pad/signature-pad-dialog', () => ({
  SignaturePadDialog: 'signature-pad-dialog',
}));
vi.mock('@documenso/ui/primitives/use-toast', () => ({
  useToast: () => ({ toast: harness.toast }),
}));
vi.mock('@lingui/core/macro', () => ({ msg: (value: string) => value }));
vi.mock('@lingui/react', () => ({ Trans: 'trans', useLingui: () => ({ _: (value: string) => value }) }));
vi.mock('@lingui/react/macro', () => ({ Trans: 'trans' }));
vi.mock('lucide-react', () => ({
  LucideChevronDown: 'chevron-down',
  LucideChevronUp: 'chevron-up',
}));
vi.mock('~/components/general/branding-logo', () => ({ BrandingLogo: 'branding-logo' }));
vi.mock('~/components/general/pdf-viewer/pdf-viewer-lazy', () => ({ default: 'pdf-viewer-lazy' }));
vi.mock('~/utils/css-vars', () => ({ injectCss: harness.injectCss }));
vi.mock('~/utils/toast-error-messages', () => ({
  getSigningCompletionErrorMessage: () => ({ title: 'Error', description: 'Failed' }),
}));
vi.mock('../general/document-signing/document-signing-attachments-popover', () => ({
  DocumentSigningAttachmentsPopover: 'attachments-popover',
}));
vi.mock('../general/document-signing/document-signing-auto-sign', () => ({
  DocumentSigningAutoSign: 'auto-sign',
}));
vi.mock('../general/document-signing/document-signing-provider', () => ({
  useRequiredDocumentSigningContext: () => ({
    email: harness.email,
    fullName: harness.fullName,
    setEmail: harness.setEmail,
    setFullName: harness.setFullName,
    setSignature: harness.setSignature,
    signature: harness.signature,
  }),
}));
vi.mock('../general/document-signing/document-signing-recipient-provider', () => ({
  DocumentSigningRecipientProvider: 'recipient-provider',
}));
vi.mock('../general/document-signing/document-signing-reject-dialog', () => ({
  DocumentSigningRejectDialog: 'reject-dialog',
}));
vi.mock('./embed-client-loading', () => ({ EmbedClientLoading: 'embed-client-loading' }));
vi.mock('./embed-document-completed', () => ({ EmbedDocumentCompleted: 'embed-document-completed' }));
vi.mock('./embed-document-fields', () => ({ EmbedDocumentFields: 'embed-document-fields' }));
vi.mock('./embed-document-rejected', () => ({ EmbedDocumentRejected: 'embed-document-rejected' }));
vi.mock('./use-persist-embed-signature', () => ({
  usePersistEmbedSignature: () => ({ persistSignature: harness.persistSignature }),
}));

import {
  EmbedSignDocumentV1ClientPage,
  type EmbedSignDocumentV1ClientPageProps,
} from './embed-document-signing-page-v1';

const mountV1Embed = (overrides: Partial<EmbedSignDocumentV1ClientPageProps> = {}) => {
  harness.hookIndex = 0;

  const props: EmbedSignDocumentV1ClientPageProps = {
    token: 'token-v1',
    documentId: 101,
    envelopeId: 'env-101',
    envelopeItems: [{ id: 'item-1', envelopeId: 'env-101', documentData: { id: 'doc-1' } }],
    recipient: {
      id: 1,
      token: 'token-v1',
      email: 'vet@example.com',
      name: 'Dr Vet',
      role: 'SIGNER',
      signingStatus: SigningStatus.NOT_SIGNED,
      fields: [],
    } as unknown as EmbedSignDocumentV1ClientPageProps['recipient'],
    fields: [],
    completedFields: [],
    metadata: {
      uploadSignatureEnabled: true,
      drawSignatureEnabled: true,
      typedSignatureEnabled: true,
    } as unknown as EmbedSignDocumentV1ClientPageProps['metadata'],
    isCompleted: false,
    isRejected: false,
    ...overrides,
  };

  return EmbedSignDocumentV1ClientPage(props) as ReactElement;
};

describe('EmbedSignDocumentV1ClientPage signature initialization', () => {
  beforeEach(() => {
    harness.completeDocumentWithToken = vi.fn().mockResolvedValue({ status: 'OK' });
    harness.email = '';
    harness.fullName = '';
    harness.hookIndex = 0;
    harness.hookState = [];
    harness.injectCss = vi.fn();
    harness.layoutRan = false;
    harness.persistSignature = vi.fn();
    harness.postMessage = vi.fn();
    harness.setEmail = vi.fn();
    harness.setFullName = vi.fn();
    harness.setSignature = vi.fn();
    harness.signature = null;
    harness.toast = vi.fn();

    (globalThis as Record<string, unknown>).window = {
      location: { hash: '' },
      parent: { postMessage: harness.postMessage },
    };
    (globalThis as Record<string, unknown>).document = {
      documentElement: { classList: { add: vi.fn() } },
    };
  });

  it('refuses hash signature prefill when both uploadSignatureEnabled and drawSignatureEnabled are false', () => {
    (globalThis.window as unknown as { location: { hash: string } }).location.hash = encodeHash({
      name: 'Dr Vet',
      signature: PNG_DATA_URL,
    });

    mountV1Embed({
      metadata: {
        uploadSignatureEnabled: false,
        drawSignatureEnabled: false,
        typedSignatureEnabled: true,
      } as unknown as EmbedSignDocumentV1ClientPageProps['metadata'],
    });

    expect(harness.setFullName).toHaveBeenCalledWith('Dr Vet');
    expect(harness.setSignature).not.toHaveBeenCalled();
    expect(harness.completeDocumentWithToken).not.toHaveBeenCalled();
    expect(harness.persistSignature).not.toHaveBeenCalled();
  });

  it.each([
    ['PNG with upload enabled only', PNG_DATA_URL, true, false],
    ['JPEG with draw enabled only', JPEG_DATA_URL, false, true],
  ])('initializes %s without auto-signing or persisting', (_label, signature, uploadSignatureEnabled, drawSignatureEnabled) => {
    (globalThis.window as unknown as { location: { hash: string } }).location.hash = encodeHash({
      signature,
    });

    mountV1Embed({
      metadata: {
        uploadSignatureEnabled,
        drawSignatureEnabled,
        typedSignatureEnabled: false,
      } as unknown as EmbedSignDocumentV1ClientPageProps['metadata'],
    });

    expect(harness.setSignature).toHaveBeenCalledTimes(1);
    expect(harness.setSignature).toHaveBeenCalledWith(signature);
    expect(harness.completeDocumentWithToken).not.toHaveBeenCalled();
    expect(harness.persistSignature).not.toHaveBeenCalled();
  });

  it('defaults to allowing valid PNG prefill when metadata is omitted and skips when isCompleted is true', () => {
    (globalThis.window as unknown as { location: { hash: string } }).location.hash = encodeHash({
      signature: PNG_DATA_URL,
    });

    mountV1Embed({ metadata: null, isCompleted: false });
    expect(harness.setSignature).toHaveBeenCalledWith(PNG_DATA_URL);

    harness.layoutRan = false;
    harness.hookState = [];
    harness.setSignature.mockClear();

    mountV1Embed({ metadata: null, isCompleted: true });
    expect(harness.setSignature).not.toHaveBeenCalled();
  });
});
