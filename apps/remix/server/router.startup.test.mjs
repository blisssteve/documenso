import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routerSource = await readFile(new URL('./router.ts', import.meta.url), 'utf8');

for (const migration of ['migrateDeletedAccountServiceAccount', 'migrateLegacyServiceAccount']) {
  test(`${migration} handles startup rejection`, () => {
    assert.match(routerSource, new RegExp(`void\\s+${migration}\\(\\)\\.catch\\(`));
  });
}
