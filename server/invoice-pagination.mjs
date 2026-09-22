export function parseInvoicePagination(url) {
  const pageValue = Number(url.searchParams.get('page'));
  const sizeValue = Number(url.searchParams.get('pageSize'));
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const requestedSize = Number.isInteger(sizeValue) && sizeValue > 0 ? sizeValue : 100;
  const pageSize = Math.min(requestedSize, 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageRows(rows, pagination) {
  const list = Array.isArray(rows) ? rows : [];
  return list.slice(pagination.offset, pagination.offset + pagination.pageSize);
}
