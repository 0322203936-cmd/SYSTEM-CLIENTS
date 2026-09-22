import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function shouldUseOcr(text) {
  return !String(text || '').trim();
}

export async function extractPdfTextWithOcr(pdfBuffer) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'factura-ocr-'));
  const sourcePath = path.join(temporaryDirectory, 'invoice.pdf');
  const imagePrefix = path.join(temporaryDirectory, 'invoice');
  const imagePath = `${imagePrefix}.png`;

  try {
    await fs.writeFile(sourcePath, pdfBuffer);
    await execFileAsync('pdftoppm', ['-f', '1', '-l', '1', '-r', '250', '-png', '-singlefile', sourcePath, imagePrefix]);
    const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', 'eng', '--psm', '6'], {
      maxBuffer: 5 * 1024 * 1024
    });
    return String(stdout || '');
  } catch (error) {
    throw new Error(`No se pudo leer el PDF mediante OCR: ${error.message}`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
