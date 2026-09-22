import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

async function recover() {
  console.log('Obtaining SharePoint drive...');
  const site = await graphRequest(`/sites/${sharePoint.hostname}:${sharePoint.personalSitePath}`);
  const drive = await graphRequest(`/sites/${site.id}/drive`);
  const driveId = drive.id;

  const getFolder = async (parentId, name) => {
    const escapedName = String(name).replace(/'/g, "''");
    const filter = encodeURIComponent(`name eq '${escapedName}'`);
    const existing = await graphRequest(`/drives/${driveId}/items/${parentId}/children?$filter=${filter}`);
    return existing?.value?.find(item => item.folder && item.name === name);
  };

  const root = await graphRequest(`/drives/${driveId}/root/children`);
  const pacificaRoot = root?.value?.find(item => item.name === sharePoint.rootFolder);
  if (!pacificaRoot) throw new Error('No root folder');
  const renameMap = {
    'Invoice-7682.pdf': '103141597000000-7682.pdf',
    'Invoice-7684.pdf': '103723258000000-7684.pdf',
    'Invoice-7627.pdf': '363234000000-7627.pdf',
    'Invoice-7642.pdf': '363379000000-7642.pdf',
    'Invoice-7685.pdf': '363486000000-7685.pdf',
    'Invoice-7672.pdf': '512607598000000-7672.pdf',
    'Invoice-000270.pdf': 'Invoice 000270.pdf'
  };

  const filesRes = await graphRequest(`/drives/${driveId}/items/${pacificaRoot.id}/children`);
  const rootFiles = filesRes?.value || [];

  for (const [currentName, newName] of Object.entries(renameMap)) {
    const file = rootFiles.find(f => f.name === currentName);
    if (file) {
      console.log(`Renaming ${currentName} to ${newName}`);
      await graphRequest(`/drives/${driveId}/items/${file.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
    }
  }
}

recover().catch(console.error);
