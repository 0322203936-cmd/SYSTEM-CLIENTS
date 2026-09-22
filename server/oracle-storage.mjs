import { promises as fs } from 'node:fs';
import { ObjectStorageClient } from 'oci-objectstorage';
import {
  ConfigFileAuthenticationDetailsProvider,
  InstancePrincipalsAuthenticationDetailsProviderBuilder,
  SimpleAuthenticationDetailsProvider
} from 'oci-common';

const namespaceName = String(process.env.OCI_NAMESPACE || '').trim();
const bucketName = String(process.env.OCI_BUCKET_NAME || 'facturacion-clientes-pdfs').trim();
const regionId = String(process.env.OCI_REGION || 'us-chicago-1').trim();
const authMode = String(process.env.OCI_AUTH_MODE || 'disabled').trim().toLowerCase();
const configFile = String(process.env.OCI_CONFIG_FILE || '').trim();
const configProfile = String(process.env.OCI_CONFIG_PROFILE || 'DEFAULT').trim();
const tenancyId = String(process.env.OCI_TENANCY_ID || '').trim();
const userId = String(process.env.OCI_USER_ID || '').trim();
const fingerprint = String(process.env.OCI_FINGERPRINT || '').trim();
const privateKeyPath = String(process.env.OCI_PRIVATE_KEY_PATH || '').trim();
const privateKeyPassphrase = process.env.OCI_PRIVATE_KEY_PASSPHRASE || null;

let clientPromise;
let lastWarningAt = 0;

export function oracleStorageReady() {
  if (!namespaceName || !bucketName || !regionId) return false;
  if (authMode === 'instance_principal') return true;
  if (authMode === 'config') return true;
  return Boolean(tenancyId && userId && fingerprint && privateKeyPath);
}

async function authenticationProvider() {
  if (authMode === 'instance_principal') {
    return new InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  }
  if (authMode === 'config') {
    return new ConfigFileAuthenticationDetailsProvider(configFile || undefined, configProfile);
  }
  if (authMode === 'api_key') {
    const privateKey = await fs.readFile(privateKeyPath, 'utf8');
    return new SimpleAuthenticationDetailsProvider(
      tenancyId,
      userId,
      fingerprint,
      privateKey,
      privateKeyPassphrase
    );
  }
  throw new Error(`OCI_AUTH_MODE no válido: ${authMode}`);
}

async function getClient() {
  if (!oracleStorageReady()) return null;
  clientPromise ||= (async () => {
    const provider = await authenticationProvider();
    const client = new ObjectStorageClient({ authenticationDetailsProvider: provider });
    client.regionId = regionId;
    return client;
  })();
  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = undefined;
    throw error;
  }
}

function warnOnce(error) {
  if (Date.now() - lastWarningAt < 30_000) return;
  lastWarningAt = Date.now();
  console.warn(`[Oracle Object Storage] ${error?.message || error}`);
}

async function streamToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const chunks = [];
  for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function getOracleObject(objectName) {
  try {
    const client = await getClient();
    if (!client || !objectName) return null;
    const response = await client.getObject({ namespaceName, bucketName, objectName: String(objectName) });
    return await streamToBuffer(response.value);
  } catch (error) {
    // A missing object or a temporary OCI failure must not break the SharePoint fallback.
    warnOnce(error);
    return null;
  }
}

export async function putOracleObject(objectName, buffer, contentType = 'application/pdf') {
  try {
    const client = await getClient();
    if (!client || !objectName || !buffer) return null;
    return await client.putObject({
      namespaceName,
      bucketName,
      objectName: String(objectName),
      contentLength: buffer.length,
      contentType,
      putObjectBody: buffer
    });
  } catch (error) {
    warnOnce(error);
    throw error;
  }
}

export async function deleteOracleObject(objectName) {
  try {
    const client = await getClient();
    if (!client || !objectName) return false;
    await client.deleteObject({ namespaceName, bucketName, objectName: String(objectName) });
    return true;
  } catch (error) {
    // Deleting an already missing object is idempotent for synchronization purposes.
    if (error?.statusCode === 404 || error?.status === 404 || error?.opcRequestId && error?.serviceCode === 'ObjectNotFound') return false;
    warnOnce(error);
    throw error;
  }
}
