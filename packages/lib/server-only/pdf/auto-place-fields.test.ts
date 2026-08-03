import type { PDF } from '@libpdf/core';
import { describe, expect, it, vi } from 'vitest';

import type { BoundingBox } from './auto-place-fields';
import { buildPlaceholderIndex } from './auto-place-fields';

/**
 * Build a synthetic TextMatch shape containing only the fields the indexer
 * consumes. We intentionally avoid loading real PDFs to keep the test fast and
 * fixture-only.
 */
type FakeMatch = {
  text: string;
  bbox: BoundingBox;
  pageIndex: number;
};

type FakePage = {
  index: number;
  findText: ReturnType<typeof vi.fn>;
};

const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;

const makeMatch = (text: string, pageIndex: number, bbox: BoundingBox): FakeMatch => ({
  text,
  bbox,
  pageIndex,
});

const makePage = (index: number, matches: FakeMatch[]): FakePage => ({
  index,
  findText: vi.fn((_query: RegExp) => matches),
});

const makePdf = (pages: FakePage[]) => ({ getPages: () => pages }) as unknown as PDF;

describe('buildPlaceholderIndex', () => {
  it('indexes 162 placeholders across 78 pages with one scan per page and deterministic lookup', () => {
    const PAGE_COUNT = 78;
    const PLACEHOLDER_COUNT = 162;

    // Assign placeholder `i` to page `i % PAGE_COUNT`, each with a unique bbox.
    const pagesByIndex: FakeMatch[][] = Array.from({ length: PAGE_COUNT }, () => []);

    const expected: Array<{ placeholder: string; pageIndex: number; bbox: BoundingBox }> = [];

    for (let i = 0; i < PLACEHOLDER_COUNT; i++) {
      const pageIndex = i % PAGE_COUNT;
      const placeholder = `{{P${i}}}`;
      const bbox: BoundingBox = { x: i * 10, y: i * 5, width: 100, height: 20 };

      pagesByIndex[pageIndex].push(makeMatch(placeholder, pageIndex, bbox));
      expected.push({ placeholder, pageIndex, bbox });
    }

    const pages = pagesByIndex.map((matches, index) => makePage(index, matches));
    const pdfDoc = makePdf(pages);

    const index = buildPlaceholderIndex(pdfDoc);

    // Every unique placeholder is present exactly once.
    expect(index.size).toBe(PLACEHOLDER_COUNT);

    // Deterministic lookup correctness for every placeholder.
    for (const { placeholder, pageIndex, bbox } of expected) {
      const entries = index.get(placeholder);

      expect(entries).toBeDefined();
      expect(entries).toHaveLength(1);
      expect(entries![0].pageIndex).toBe(pageIndex);
      expect(entries![0].bbox).toEqual(bbox);
    }

    // Each page's findText is called exactly once (one-pass).
    for (const page of pages) {
      expect(page.findText).toHaveBeenCalledTimes(1);
    }
  });

  it('groups a duplicate placeholder across pages, preserving page order and exact bbox data', () => {
    const placeholder = '{{DUP}}';
    const bbox0: BoundingBox = { x: 10, y: 20, width: 30, height: 40 };
    const bbox1: BoundingBox = { x: 11, y: 22, width: 33, height: 44 };
    const bbox5: BoundingBox = { x: 15, y: 25, width: 35, height: 45 };

    const pages = [
      makePage(0, [makeMatch(placeholder, 0, bbox0)]),
      makePage(1, [makeMatch(placeholder, 1, bbox1)]),
      makePage(2, []),
      makePage(3, []),
      makePage(4, []),
      makePage(5, [makeMatch(placeholder, 5, bbox5)]),
    ];

    const pdfDoc = makePdf(pages);

    const index = buildPlaceholderIndex(pdfDoc);

    const entries = index.get(placeholder);

    expect(entries).toBeDefined();
    expect(entries).toHaveLength(3);

    // Page order preserved (ascending page index, matching iteration order).
    expect(entries!.map((entry) => entry.pageIndex)).toEqual([0, 1, 5]);

    // Exact bbox preservation.
    expect(entries![0].bbox).toEqual(bbox0);
    expect(entries![1].bbox).toEqual(bbox1);
    expect(entries![2].bbox).toEqual(bbox5);

    // Empty pages still contribute nothing and are scanned exactly once.
    expect(index.size).toBe(1);
    for (const page of pages) {
      expect(page.findText).toHaveBeenCalledTimes(1);
    }
  });
});
