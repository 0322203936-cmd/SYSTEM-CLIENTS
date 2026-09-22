import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const sharePoint = {
  tenantId: process.env.SHAREPOINT_TENANT_ID,
  clientId: process.env.SHAREPOINT_CLIENT_ID,
  clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
  hostname: 'pacificafarms-my.sharepoint.com',
  personalSitePath: '/personal/michele_martinez_cfbc_co',
  rootFolder: '02.PACIFICA'
};
let graphToken = { value: '', expiresAt: 0 };

async function graphAccessToken() {
  if (graphToken.value && graphToken.expiresAt > Date.now() + 60_000) return graphToken.value;
  const body = new URLSearchParams({ client_id: sharePoint.clientId, client_secret: sharePoint.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const response = await fetch(`https://login.microsoftonline.com/${sharePoint.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'No fue posible autenticar con Microsoft Graph.');
  graphToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return graphToken.value;
}

async function graphRequest(endpoint, options = {}) {
  const token = await graphAccessToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Microsoft Graph respondió ${response.status}.`);
  return data;
}

async function list() {
  const site = await graphRequest(`/sites/${sharePoint.hostname}:${sharePoint.personalSitePath}`);
  const drive = await graphRequest(`/sites/${site.id}/drive`);
  const root = await graphRequest(`/drives/${drive.id}/root/children`);
  const pacificaRoot = root?.value?.find(item => item.name === sharePoint.rootFolder);

  const filesRes = await graphRequest(`/drives/${drive.id}/items/${pacificaRoot.id}/children`);
  console.log("FILES IN 02.PACIFICA ROOT:");
  for (const f of filesRes?.value || []) {
      console.log(` - ${f.name} (Folder: ${!!f.folder})`);
  }
}
list().catch(console.error);
