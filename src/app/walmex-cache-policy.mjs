/** Cached Walmex data is only safe when authorization did not fail. */
export function shouldUseWalmexCache(status) {
  return status !== 401 && status !== 403;
}
