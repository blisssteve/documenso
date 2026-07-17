import { DocumentAuth } from '@documenso/lib/types/document-auth';
import { FieldType, RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  AUTO_FILL_CONCURRENCY,
  getV2AutoFillAuthOptions,
  getV2AutoFillFields,
  getV2AutoFillValue,
  isV2AutoFillAllowed,
  mapV2AutoFill,
  mapWithBoundedConcurrency,
  shouldPromptForV2AutoFill,
} from './v2-embed-auto-fill';

const field = (id: number, type: FieldType, inserted = false) => ({ id, type, inserted });

describe('v2 embedded auto fill', () => {
  it('uses the existing greater-than-five threshold', () => {
    expect(
      getV2AutoFillFields(
        Array.from({ length: 5 }, (_, id) => field(id, FieldType.INITIALS)),
        'Vet Name',
        '',
      ),
    ).toHaveLength(5);
    expect(
      getV2AutoFillFields(
        Array.from({ length: 6 }, (_, id) => field(id, FieldType.INITIALS)),
        'Vet Name',
        '',
      ),
    ).toHaveLength(6);
    expect(shouldPromptForV2AutoFill(5, true)).toBe(false);
    expect(shouldPromptForV2AutoFill(6, true)).toBe(true);
    expect(shouldPromptForV2AutoFill(6, false)).toBe(false);
  });

  it('includes exactly unsigned NAME, INITIALS, EMAIL and DATE fields when identity data exists', () => {
    const fields = [
      field(1, FieldType.NAME),
      field(2, FieldType.INITIALS),
      field(3, FieldType.EMAIL),
      field(4, FieldType.DATE),
      field(5, FieldType.SIGNATURE),
      field(6, FieldType.TEXT),
      field(7, FieldType.INITIALS, true),
    ];

    expect(getV2AutoFillFields(fields, 'Ada Lovelace', 'ada@example.com').map(({ id }) => id)).toEqual([1, 2, 3, 4]);
  });

  it('excludes name and initials without a full name, and email without an email address', () => {
    const fields = [
      field(1, FieldType.NAME),
      field(2, FieldType.INITIALS),
      field(3, FieldType.EMAIL),
      field(4, FieldType.DATE),
    ];

    expect(getV2AutoFillFields(fields, '', '').map(({ id }) => id)).toEqual([4]);
  });

  it('maps fields to v2 discriminated values and derives initials from the full name', () => {
    expect(getV2AutoFillValue(FieldType.NAME, 'Ada Byron Lovelace', 'ada@example.com')).toEqual({
      type: FieldType.NAME,
      value: 'Ada Byron Lovelace',
    });
    expect(getV2AutoFillValue(FieldType.INITIALS, 'Ada Byron Lovelace', 'ada@example.com')).toEqual({
      type: FieldType.INITIALS,
      value: 'AB',
    });
    expect(getV2AutoFillValue(FieldType.EMAIL, 'Ada Byron Lovelace', 'ada@example.com')).toEqual({
      type: FieldType.EMAIL,
      value: 'ada@example.com',
    });
    expect(getV2AutoFillValue(FieldType.DATE, 'Ada Byron Lovelace', 'ada@example.com')).toEqual({
      type: FieldType.DATE,
      value: true,
    });
    expect(() => getV2AutoFillValue(FieldType.SIGNATURE, 'Ada', 'ada@example.com')).toThrow();
  });

  it.each([
    DocumentAuth.PASSWORD,
    DocumentAuth.TWO_FACTOR_AUTH,
    DocumentAuth.PASSKEY,
  ])('suppresses auto fill for %s action auth', (authType) => {
    expect(isV2AutoFillAllowed(RecipientRole.SIGNER, [authType])).toBe(false);
  });

  it('does not allow assistants and maps only non-interactive auth options', () => {
    expect(isV2AutoFillAllowed(RecipientRole.ASSISTANT, [])).toBe(false);
    expect(isV2AutoFillAllowed(RecipientRole.SIGNER, [DocumentAuth.ACCOUNT])).toBe(true);
    expect(getV2AutoFillAuthOptions([DocumentAuth.ACCOUNT])).toEqual({ type: DocumentAuth.ACCOUNT });
    expect(getV2AutoFillAuthOptions([DocumentAuth.EXPLICIT_NONE])).toEqual({ type: DocumentAuth.EXPLICIT_NONE });
    expect(getV2AutoFillAuthOptions([])).toBeUndefined();
  });

  it.each([100, 300])('keeps %i field operations within fixed concurrency and preserves results', async (count) => {
    let active = 0;
    let maxActive = 0;
    const ids = Array.from({ length: count }, (_, id) => id);

    const results = await mapWithBoundedConcurrency(ids, AUTO_FILL_CONCURRENCY, async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, id % 3));
      active -= 1;
      return id * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(AUTO_FILL_CONCURRENCY);
    expect(results).toEqual(ids.map((id) => ({ status: 'fulfilled', value: id * 2 })));
  });

  it('preserves successes and identifies only failed work for retry', async () => {
    const attempted: number[] = [];
    const first = await mapWithBoundedConcurrency([1, 2, 3], 2, async (id) => {
      attempted.push(id);
      await Promise.resolve();

      if (id === 2) {
        throw new Error('forced');
      }

      return id;
    });
    const remaining = [1, 2, 3].filter((_id, index) => first[index].status === 'rejected');
    const retry = await mapWithBoundedConcurrency(remaining, 2, async (id) => {
      attempted.push(id);
      await Promise.resolve();
      return id;
    });

    expect(first.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(remaining).toEqual([2]);
    expect(retry).toEqual([{ status: 'fulfilled', value: 2 }]);
    expect(attempted).toEqual([1, 2, 3, 2]);
  });

  it('performs no field mutations when the dialog does not submit any fields', async () => {
    const attempted: number[] = [];
    const results = await mapV2AutoFill([], async (id) => {
      attempted.push(id);
      await Promise.resolve();
      return id;
    });

    expect(results).toEqual([]);
    expect(attempted).toEqual([]);
  });
});
