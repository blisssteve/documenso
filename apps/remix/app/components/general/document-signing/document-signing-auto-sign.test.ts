import { DocumentAuth, type TRecipientActionAuthTypes } from '@documenso/lib/types/document-auth';
import { type Field, FieldType } from '@prisma/client';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal hooks harness for the shared V1 standard and embedded signing control.
const harness = vi.hoisted(() => ({
  actionAuth: [] as TRecipientActionAuthTypes[],
  email: 'vet@example.com',
  fields: [] as Array<{ id: number; inserted: boolean; type: FieldType }>,
  fullName: 'Vet Name',
  hookIndex: 0,
  hookState: [] as unknown[],
  revalidate: vi.fn().mockResolvedValue(undefined),
  signFieldWithToken: vi.fn().mockResolvedValue({ inserted: true }),
  toast: vi.fn(),
}));

vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');

  return {
    ...react,
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

vi.mock('@documenso/trpc/react', () => ({
  trpc: {
    field: {
      signFieldWithToken: {
        useMutation: () => ({ mutateAsync: harness.signFieldWithToken }),
      },
    },
  },
}));
vi.mock('@documenso/ui/primitives/button', () => ({ Button: 'button' }));
vi.mock('@documenso/ui/primitives/use-toast', () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: harness.revalidate }) }));
vi.mock('@lingui/react/macro', () => ({ Trans: 'trans' }));
vi.mock('@lingui/core/macro', () => ({ msg: (value: string) => value }));
vi.mock('@lingui/react', () => ({ useLingui: () => ({ _: (value: string) => value }) }));

vi.mock('./document-signing-provider', () => ({
  useRequiredDocumentSigningContext: () => ({ fullName: harness.fullName, email: harness.email }),
}));
vi.mock('./document-signing-auth-provider', () => ({
  useRequiredDocumentSigningAuthContext: () => ({ derivedRecipientActionAuth: harness.actionAuth }),
}));

import { DocumentSigningAutoSign } from './document-signing-auto-sign';

const elements = (node: ReactNode): ReactElement[] => {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }

  if (!node || typeof node !== 'object' || !('props' in node)) {
    return [];
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elements(element.props.children)];
};

const text = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(text).join('');
  }

  return node && typeof node === 'object' && 'props' in node
    ? text((node as ReactElement<{ children?: ReactNode }>).props.children)
    : '';
};

const field = (id: number, type: FieldType = FieldType.INITIALS, inserted = false) => ({ id, inserted, type });

const render = () => {
  harness.hookIndex = 0;
  // ponytail: harness uses minimal {id,inserted,type} shapes; cast to the prop type for tsc, runtime ignores extras.
  return DocumentSigningAutoSign({
    recipient: { id: 1, token: 'token-abc' },
    fields: harness.fields as unknown as Field[],
  }) as ReactElement | null;
};

const fillButton = (node: ReactNode) =>
  elements(node).find((element) => element.type === 'button' && /^Fill Name/.test(text(element)));

describe('DocumentSigningAutoSign (V1 standard route)', () => {
  beforeEach(() => {
    harness.actionAuth = [];
    harness.email = 'vet@example.com';
    harness.fields = [];
    harness.fullName = 'Vet Name';
    harness.hookIndex = 0;
    harness.hookState = [];
    harness.revalidate = vi.fn().mockResolvedValue(undefined);
    harness.signFieldWithToken = vi.fn().mockResolvedValue({ inserted: true });
    harness.toast = vi.fn();
  });

  it('renders no popup/dialog; only a visible button when a NAME field is unsigned (document_14 shape)', () => {
    // Fresh BullCheck document_14: 1 NAME, 1 DATE, 1 SIGNATURE — no auto-prompt before, now a button.
    harness.fullName = 'Steve Bliss';
    harness.fields = [field(1, FieldType.NAME), field(2, FieldType.DATE), field(3, FieldType.SIGNATURE)];

    const view = render();

    // No Dialog rendered: consent-based visible button only (no auto-popup / mount mutation).
    expect(elements(view).some((element) => element.type === 'dialog')).toBe(false);
    const button = fillButton(view);
    expect(button).toBeDefined();
    expect(text(button)).toBe('Fill Name and Initials (1)');
  });

  it('signs only the NAME field on click for the document_14 shape; never DATE or SIGNATURE', async () => {
    harness.fullName = 'Steve Bliss';
    harness.fields = [
      field(1, FieldType.NAME),
      field(2, FieldType.DATE),
      field(3, FieldType.SIGNATURE),
      field(4, FieldType.EMAIL),
    ];

    const button = fillButton(render());

    await button?.props.onClick();

    expect(harness.signFieldWithToken).toHaveBeenCalledTimes(1);
    expect(harness.signFieldWithToken).toHaveBeenCalledWith({
      token: 'token-abc',
      fieldId: 1,
      value: 'Steve Bliss',
      isBase64: false,
      authOptions: undefined,
    });
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
  });

  it('signs every unsigned NAME and INITIALS field with mapped values (multi-bull shape)', async () => {
    harness.fullName = 'Steve Bliss';
    harness.fields = [
      field(1, FieldType.NAME),
      field(2, FieldType.INITIALS),
      field(3, FieldType.INITIALS),
      field(4, FieldType.INITIALS),
    ];

    const button = fillButton(render());

    expect(text(button)).toBe('Fill Name and Initials (4)');
    await button?.props.onClick();

    expect(harness.signFieldWithToken.mock.calls.map(([payload]) => payload.fieldId)).toEqual([1, 2, 3, 4]);
    expect(harness.signFieldWithToken).toHaveBeenCalledWith({
      token: 'token-abc',
      fieldId: 1,
      value: 'Steve Bliss',
      isBase64: false,
      authOptions: undefined,
    });
    expect(harness.signFieldWithToken).toHaveBeenCalledWith({
      token: 'token-abc',
      fieldId: 2,
      value: 'SB',
      isBase64: false,
      authOptions: undefined,
    });
  });

  it('never signs DATE, EMAIL, or SIGNATURE even when present and unsigned', async () => {
    harness.fields = [
      field(1, FieldType.DATE),
      field(2, FieldType.EMAIL),
      field(3, FieldType.SIGNATURE),
      field(4, FieldType.NAME),
    ];

    const button = fillButton(render());

    await button?.props.onClick();

    expect(harness.signFieldWithToken).toHaveBeenCalledTimes(1);
    expect(harness.signFieldWithToken.mock.calls.map(([payload]) => payload.fieldId)).toEqual([4]);
  });

  it('hides the button when no unsigned NAME/INITIALS field exists', () => {
    harness.fields = [
      field(1, FieldType.NAME, true),
      field(2, FieldType.INITIALS, true),
      field(3, FieldType.DATE),
      field(4, FieldType.SIGNATURE),
    ];

    expect(render()).toBeNull();
  });

  it('hides the button when fullName is blank', () => {
    harness.fullName = '';
    harness.fields = [field(1, FieldType.NAME), field(2, FieldType.INITIALS)];

    expect(render()).toBeNull();
  });

  it.each([
    [DocumentAuth.PASSWORD],
    [DocumentAuth.PASSKEY],
    [DocumentAuth.TWO_FACTOR_AUTH],
  ])('hides the button when action auth is restricted (%s)', (actionAuth) => {
    harness.actionAuth = [actionAuth];
    harness.fields = [field(1, FieldType.NAME), field(2, FieldType.INITIALS)];

    expect(render()).toBeNull();
  });

  it('maps ACCOUNT action auth into authOptions on every signing call', async () => {
    harness.actionAuth = [DocumentAuth.ACCOUNT];
    harness.fields = [field(1, FieldType.NAME)];

    await fillButton(render())?.props.onClick();

    expect(harness.signFieldWithToken).toHaveBeenCalledWith({
      token: 'token-abc',
      fieldId: 1,
      value: 'Vet Name',
      isBase64: false,
      authOptions: { type: DocumentAuth.ACCOUNT },
    });
  });

  it('locks while a fill is in flight to prevent duplicate clicks', async () => {
    let resolveSign!: (value: { inserted: boolean }) => void;
    harness.signFieldWithToken.mockReturnValue(
      new Promise<{ inserted: boolean }>((resolve) => {
        resolveSign = resolve;
      }),
    );
    harness.fields = [field(1, FieldType.INITIALS), field(2, FieldType.INITIALS)];

    const firstClick = fillButton(render())?.props.onClick();
    // Second invocation while the first is pending: the button's disabled/loading gate holds.
    const buttonDuring = fillButton(render());
    expect(buttonDuring?.props.loading).toBe(true);
    expect(buttonDuring?.props.disabled).toBe(true);

    resolveSign({ inserted: true });
    await firstClick;
  });

  it('toasts a destructive message and still revalidates when any signing call rejects', async () => {
    harness.signFieldWithToken.mockResolvedValueOnce({ inserted: true }).mockRejectedValueOnce(new Error('forced'));
    harness.fields = [field(1, FieldType.NAME), field(2, FieldType.INITIALS)];

    await fillButton(render())?.props.onClick();

    expect(harness.toast).toHaveBeenCalledTimes(1);
    expect(harness.toast.mock.calls[0]?.[0]?.variant).toBe('destructive');
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
  });
});
