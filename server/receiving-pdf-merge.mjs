import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PRINT_PAGE_WIDTH = 612;
export const PRINT_PAGE_HEIGHT = 792;
const PRINT_MARGIN = 18;
const execFileAsync = promisify(execFile);
const pdfUniteCommand = process.env.PDFUNITE_PATH || 'pdfunite';

async function mergeWithPdfUnite(buffers) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'facturacion-pdf-'));
  try {
    const inputPaths = [];
    for (let index = 0; index < buffers.length; index += 1) {
      const inputPath = path.join(tempDir, `part-${index}.pdf`);
      await fs.writeFile(inputPath, buffers[index]);
      inputPaths.push(inputPath);
    }
    const outputPath = path.join(tempDir, 'merged.pdf');
    await execFileAsync(pdfUniteCommand, [...inputPaths, outputPath], { timeout: 120_000 });
    return await fs.readFile(outputPath);
  } catch {
    // Windows/local installations may not have Poppler. Keep the JS fallback.
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function fitInsidePage(width, height) {
  const availableWidth = PRINT_PAGE_WIDTH - (PRINT_MARGIN * 2);
  const availableHeight = PRINT_PAGE_HEIGHT - (PRINT_MARGIN * 2);
  const scale = Math.min(availableWidth / width, availableHeight / height);
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  return {
    width: outputWidth,
    height: outputHeight,
    x: (PRINT_PAGE_WIDTH - outputWidth) / 2,
    y: (PRINT_PAGE_HEIGHT - outputHeight) / 2
  };
}

function fitToPrintPage(width, height) {
  const scale = Math.min(PRINT_PAGE_WIDTH / width, PRINT_PAGE_HEIGHT / height);
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  return {
    width: outputWidth,
    height: outputHeight,
    x: (PRINT_PAGE_WIDTH - outputWidth) / 2,
    y: (PRINT_PAGE_HEIGHT - outputHeight) / 2
  };
}

export async function normalizePdfBufferToPrintSize(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer);
    for (const page of pdf.getPages()) {
      const placement = fitToPrintPage(page.getWidth(), page.getHeight());
      const scale = placement.width / page.getWidth();
      page.scaleContent(scale, scale);
      page.setSize(PRINT_PAGE_WIDTH, PRINT_PAGE_HEIGHT);
      page.translateContent(placement.x, placement.y);
    }
    return Buffer.from(await pdf.save());
  } catch {
    // Keep the native merge if a supplier PDF cannot be rewritten by pdf-lib.
    return buffer;
  }
}

async function appendPdf(mergedPdf, buffer) {
  try {
    const sourcePdf = await PDFDocument.load(buffer);
    // Copy the original pages instead of rendering them into an embedded canvas.
    // This keeps the original fonts, vectors and image resolution intact.
    const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    copiedPages.forEach(page => {
      const placement = fitInsidePage(page.getWidth(), page.getHeight());
      const scale = placement.width / page.getWidth();
      page.scaleContent(scale, scale);
      page.setSize(PRINT_PAGE_WIDTH, PRINT_PAGE_HEIGHT);
      page.translateContent(placement.x, placement.y);
      mergedPdf.addPage(page);
    });
  } catch (loadError) {
    const parser = new PDFParse({ data: buffer });
    try {
      // Only malformed PDFs reach this fallback. Use a higher-resolution render
      // so their printed output remains as sharp as possible.
      const screenshots = await parser.getScreenshot({ scale: 3, imageBuffer: true });
      for (const screenshot of screenshots.pages) {
        const image = await mergedPdf.embedPng(Buffer.from(screenshot.data));
        const placement = fitInsidePage(screenshot.width, screenshot.height);
        const page = mergedPdf.addPage([PRINT_PAGE_WIDTH, PRINT_PAGE_HEIGHT]);
        page.drawImage(image, placement);
      }
    } finally {
      await parser.destroy();
    }
  }
}

export async function mergeReceivingPdfBuffers(buffers) {
  if (!Array.isArray(buffers) || buffers.length < 2) {
    throw new Error('Se necesitan al menos dos PDFs para unir un recibimiento.');
  }

  // pdfunite copies the original PDF objects without rasterizing or rewriting
  // their fonts. It is especially important for the supplier PDFs that
  // pdf-lib cannot parse reliably.
  const nativeMerged = await mergeWithPdfUnite(buffers);
  if (nativeMerged) return normalizePdfBufferToPrintSize(nativeMerged);

  const mergedPdf = await PDFDocument.create();
  for (const buffer of buffers) {
    await appendPdf(mergedPdf, buffer);
  }

  return Buffer.from(await mergedPdf.save());
}
