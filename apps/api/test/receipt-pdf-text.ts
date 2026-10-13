import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/** Decode the actual page text operators emitted by the receipt's WinAnsi font. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes);
  const lines: string[] = [];
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const content = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    for (const match of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      lines.push(Buffer.from(match[1] ?? '', 'hex').toString('latin1'));
    }
  }
  return lines.join('\n');
}
