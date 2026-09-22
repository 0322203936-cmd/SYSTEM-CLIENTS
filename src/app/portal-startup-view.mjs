export function getPortalStartupView(href) {
  const url = new URL(href);
  url.searchParams.delete('view');
  return {
    activeTab: 'dashboard',
    reconciliationView: false,
    url: url.toString(),
  };
}
