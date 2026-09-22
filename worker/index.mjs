const API_PREFIX = '/api/';
import { tryDirectApi } from './direct-api.mjs';

function isApiRequest(pathname) {
  return pathname === '/api' || pathname.startsWith(API_PREFIX);
}

function buildApiUrl(request, originApi) {
  const requestUrl = new URL(request.url);
  const origin = new URL(originApi);
  origin.pathname = requestUrl.pathname;
  origin.search = requestUrl.search;
  return origin;
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (isApiRequest(requestUrl.pathname)) {
      try {
        const directResponse = await tryDirectApi(request, env);
        if (directResponse) return directResponse;
      } catch (error) {
        return new Response(JSON.stringify({ message: error?.message || 'Error en la API serverless.' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cfbc-api': 'direct' },
        });
      }
      return new Response(JSON.stringify({ message: 'Ruta API no implementada en el Worker.' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cfbc-api': 'direct' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
