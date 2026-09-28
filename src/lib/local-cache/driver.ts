// Metro resolves driver.web.ts or driver.native.ts in app bundles.
// This fallback keeps Node unit tests independent of device storage.
import type { LocalCacheDriver } from './types';

export const localCacheDriver: LocalCacheDriver = {
  async get() { return null; },
  async put() { return undefined; },
  async remove() { return undefined; },
};
