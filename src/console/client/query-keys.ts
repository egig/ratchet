/** Central `queryKey` conventions for the console client's React Query cache — kept in one place
 * so a mutation against one model (create/update/delete a row, upload a file, run a custom
 * operation) can invalidate every view of that model's data with one call, regardless of which
 * component fetched it or what list params it used (`rows(model)` with no `params` is a prefix
 * that matches every `rows(model, params)` key via React Query's default `exact: false`
 * invalidation). */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  setupStatus: ['auth', 'setupStatus'] as const,
  models: ['models'] as const,
  domains: ['domains'] as const,
  domainSettings: (domain: string) => ['domainSettings', domain] as const,
  /** `params` is any JSON-serializable object describing the query (limit/offset/filters/sort) —
   * React Query keys on deep-equality, so two calls with the same params share a cache entry.
   * Omit `params` to get the bare model-level prefix used for invalidation. */
  rows: (model: string, params?: unknown) => (params === undefined ? (['rows', model] as const) : (['rows', model, params] as const)),
  row: (model: string, id: string) => ['row', model, id] as const,
};
