import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/** Extract the actual text operators emitted by React PDF's built-in fonts. */
export async function reportPdfText(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes);
  return document.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    const content = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    return [...content.matchAll(/\[[^\]]*\]\s*TJ|<[0-9a-f]+>\s*Tj/gi)].map(match =>
      [...match[0].matchAll(/<([0-9a-f]+)>/gi)].map(part =>
        Buffer.from(part[1] ?? '', 'hex').toString('latin1')).join(''));
  }).join('\n');
}
