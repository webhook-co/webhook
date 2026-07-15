/**
 * Turn a source image + a crop rectangle into a square 512×512 `image/webp` blob, entirely in the browser.
 *
 * Why re-encode client-side at all:
 *  - It strips EXIF (GPS, camera, orientation) — the original photo's metadata never leaves the device.
 *  - It normalizes to one small square webp, so the server gate and the stored object are predictable.
 *  - The server STILL re-validates magic bytes + dimensions; this is a convenience + privacy step, not a
 *    trust boundary.
 *
 * This module is canvas-only and cannot run under jsdom (no 2D context, no `toBlob`), so it has no unit test —
 * it is exercised by the browser verification pass. Keep it thin and dependency-free for exactly that reason.
 */

/** The crop rectangle react-easy-crop reports, in SOURCE-image pixels. */
export interface PixelCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const OUTPUT_SIZE = 512;
const WEBP_QUALITY = 0.9;

/** Load a `data:`/object URL into an <img> we can draw. Rejects on decode failure rather than hanging. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be decoded."));
    img.src = src;
  });
}

export async function getCroppedWebp(imageSrc: string, crop: PixelCrop): Promise<Blob> {
  const image = await loadImage(imageSrc);

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser couldn't process the image.");

  // Draw only the cropped square region, scaled to the fixed output size.
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/webp", WEBP_QUALITY),
  );
  // A browser too old to encode webp — the server only accepts webp, so there is no useful fallback.
  if (!blob) throw new Error("Your browser can't create a webp image. Try a different browser.");
  return blob;
}

/**
 * Read a chosen file into a `data:` URL for the cropper preview.
 *
 * It MUST be a `data:` URL, not `URL.createObjectURL` (a `blob:` URL): the app CSP is `img-src 'self' data:`,
 * so a `blob:` source would be blocked and the crop preview would silently show nothing.
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(file);
  });
}
