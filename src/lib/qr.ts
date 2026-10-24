import QRCode from 'qrcode';

/**
 * QR code generation.
 *
 * Configurations are rendered as QR codes from their import string so they can
 * be scanned directly by NekoBox, v2rayN, Shadowrocket, sing-box, etc.
 * Error-correction level M keeps the code readable while remaining compact.
 *
 * The shared options object is intentionally untyped so it can be spread into
 * both the data-URL and the buffer renderers (their option types differ).
 */

const QR_BASE = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 320,
  color: {
    dark: '#0f172a',
    light: '#ffffff',
  },
} as const;

/** PNG data URL — embedded directly in an <img> tag. */
export async function generateQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, QR_BASE);
}

/** Raw PNG buffer — streamed by the download endpoint. */
export async function generateQrPngBuffer(payload: string, width = 512): Promise<Buffer> {
  return QRCode.toBuffer(payload, { ...QR_BASE, width, type: 'png' });
}

/** SVG string — infinitely scalable, useful for printable cards. */
export async function generateQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, { ...QR_BASE, type: 'svg' });
}
