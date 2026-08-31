/**
 * Reserved portable parts-resolver boundary.
 *
 * This module is intentionally not registered as a public Action. Implement the
 * PART_INTENT schema, source adapters, outputs, and tests before exposing it.
 */

export const partsResolverStatus = Object.freeze({
  status: 'reserved',
  publicAction: false,
});
