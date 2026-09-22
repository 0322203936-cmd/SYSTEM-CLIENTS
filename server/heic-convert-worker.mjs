import { parentPort, workerData } from 'node:worker_threads';
import convertHeic from 'heic-convert';

try {
  const jpegBuffer = await convertHeic({
    buffer: Buffer.from(workerData),
    format: 'JPEG',
    quality: 0.9
  });
  parentPort.postMessage({ ok: true, buffer: jpegBuffer }, [jpegBuffer.buffer]);
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || 'No se pudo convertir el archivo HEIC.' });
}
