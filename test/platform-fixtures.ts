import { readFileSync } from 'node:fs';

// Admin-editable repository documents are production state, not test fixtures.
// Keep scenario defaults deterministic while loading real theme code/schemas.
export const PLATFORM_FIXTURE_PATHS = [
  'config/site/settings.json',
  'config/gallery/categories.json',
  'content/gallery/items.json',
  'frontend/themes.json',
  'frontend/themes/firefly/config/appearance.json',
  'frontend/themes/paper/config/reading.json',
] as const;

export function readPlatformFixture(filename: string): string {
  return readFileSync(new URL('./fixtures/platform/' + filename, import.meta.url), 'utf8');
}
