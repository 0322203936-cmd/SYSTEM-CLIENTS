// Payloads for the template catalog. Logos are large base64 strings, so they
// are fetched only for the template currently being edited.
export function summarizeEmailTemplate(template) {
  const { logo, ...summary } = template || {};
  return { ...summary, hasLogo: Boolean(String(logo || '')) };
}
