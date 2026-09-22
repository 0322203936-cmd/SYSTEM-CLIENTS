const ENDPOINT = 'https://v2.convertapi.com/convert/heic/to/jpg';

export async function convertHeicToJpeg(secret, name, bytes) {
  if (!secret) throw new Error('CONVERTAPI_SECRET no está configurado en Cloudflare.');
  const form = new FormData();
  form.append('File', new File([bytes], name || 'image.heic', { type: 'image/heic' }));
  form.append('StoreFile', 'true');
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.Message || data?.message || `ConvertAPI respondió ${response.status}.`);
  const url = data?.Files?.[0]?.Url || data?.files?.[0]?.url || data?.Url || data?.url;
  if (!url) throw new Error('ConvertAPI no devolvió el JPG convertido.');
  const result = await fetch(url);
  if (!result.ok) throw new Error(`No se pudo descargar el JPG convertido (HTTP ${result.status}).`);
  return new Uint8Array(await result.arrayBuffer());
}
