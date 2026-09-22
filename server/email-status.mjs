export function publicEmailStatus({ mailReady, mailFrom, mailFromCentro } = {}) {
  return {
    mailReady: Boolean(mailReady),
    mailFrom: String(mailFrom || ''),
    mailFromCentro: String(mailFromCentro || ''),
  };
}
