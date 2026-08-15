import { promises as fs } from 'node:fs';
import { PDFParse } from 'pdf-parse';

async function main() {
  const buffer = await fs.readFile('C:/Users/Yisus/.gemini/antigravity-ide/brain/06ddc21c-3d0d-4e03-9b2b-ede2bc712256/media__1786756847670.pdf');
  const parser = new PDFParse({ data: buffer });
  const text = (await parser.getText()).text.replace(/\u00a0/g, ' ');
  await parser.destroy();
  console.log("TEXT:\n", text);

  const poMatch = text.match(/(?:^|\r?\n)PO\s*:\s*([A-Z0-9-]+)/i);
  const creditMatch = text.match(/(?:^|\r?\n)CREDIT\s*:\s*([A-Z0-9-]+)/i);
  const totalMatch = text.match(/(?:^|\r?\n| )TOTAL\s*\$?\s*([\d,]+\.\d{2})/i) || text.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i);
  
  console.log({
    po: poMatch?.[1],
    credit: creditMatch?.[1],
    amount: totalMatch?.[1]
  });
}
main();
