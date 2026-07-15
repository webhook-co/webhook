"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@webhook-co/ui";
import dynamic from "next/dynamic";
import * as React from "react";

import { uploadAvatarWebp } from "@/lib/avatar-upload";
import { fileToDataUrl, getCroppedWebp, type PixelCrop } from "@/lib/crop-image";

// react-easy-crop is ~client-only and not tiny — load it only when the dialog actually opens, never on the
// server. (Its import touches `window`; `ssr: false` keeps it off the server render entirely.) The library's
// prop type marks its many optional knobs as required; we drive only the handful below and let its runtime
// defaults cover the rest, so we type the dynamic component to just that surface.
const Cropper = dynamic(() => import("react-easy-crop"), { ssr: false }) as React.ComponentType<{
  image: string;
  crop: { x: number; y: number };
  zoom: number;
  aspect: number;
  cropShape?: "rect" | "round";
  showGrid?: boolean;
  onCropChange: (c: { x: number; y: number }) => void;
  onZoomChange: (z: number) => void;
  onCropComplete: (area: PixelCrop, areaPixels: PixelCrop) => void;
}>;

const ACCEPT = "image/png,image/jpeg,image/webp";

export interface AvatarCropperDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fired after the new avatar is stored — the caller re-renders + cache-busts. */
  readonly onUploaded: () => void;
}

/**
 * Pick a photo → crop/zoom it to a circle → store it. The heavy lifting (canvas re-encode to a square 512×512
 * webp, EXIF stripped) lives in `@/lib/crop-image`; the transport (raw-webp POST, same-origin) in
 * `@/lib/avatar-upload`. This component is the glue and the UI state machine.
 *
 * The crop/pinch/zoom TOUCH FEEL is the one thing here that a machine can't sign off — it needs a human on a
 * real device. Everything up to and including "the right bytes reach the server" is covered by tests.
 */
export function AvatarCropperDialog({ open, onOpenChange, onUploaded }: AvatarCropperDialogProps) {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);
  const [crop, setCrop] = React.useState({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState(1);
  const [pixels, setPixels] = React.useState<PixelCrop | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Cancel any in-flight upload if the dialog unmounts mid-request (e.g. navigation away) — so the network
  // request actually stops and its resolution doesn't try to touch a gone component.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const reset = React.useCallback(() => {
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setPixels(null);
    setBusy(false);
    setError(null);
  }, []);

  function handleOpenChange(next: boolean) {
    if (!next) reset(); // discard any in-progress crop when the dialog closes
    onOpenChange(next);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-choosing the same file after a cancel
    if (!file) return;
    setError(null);
    try {
      setImageSrc(await fileToDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be read.");
    }
  }

  async function save() {
    if (!imageSrc || !pixels || busy) return;
    setBusy(true);
    setError(null);
    let blob: Blob;
    try {
      blob = await getCroppedWebp(imageSrc, pixels);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "We couldn't process that image.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await uploadAvatarWebp(blob, { signal: controller.signal });
    if (res.ok) {
      reset();
      onUploaded();
    } else {
      setBusy(false);
      setError(res.error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change your photo</DialogTitle>
          <DialogDescription>
            Upload a square-ish image, then drag and zoom to frame it. It’s cropped to a circle.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {imageSrc ? (
            <>
              {/* The crop stage. Fixed height so the circle mask has room; the source sits inside it. */}
              <div className="relative h-64 w-full overflow-hidden rounded-control bg-surface-sunken">
                <Cropper
                  image={imageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  cropShape="round"
                  showGrid={false}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={(_area, areaPixels) => setPixels(areaPixels)}
                />
              </div>
              <label className="flex items-center gap-3 text-sm text-fg-secondary">
                <span className="shrink-0">Zoom</span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-full accent-[var(--wh-accent)]"
                  aria-label="Zoom"
                />
              </label>
            </>
          ) : (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-control border border-dashed border-hairline bg-surface-sunken px-4 py-10 text-center text-sm text-fg-secondary hover:bg-surface">
              <span className="font-medium text-fg">Choose a photo</span>
              <span>PNG, JPEG, or webp — square looks best.</span>
              <input type="file" accept={ACCEPT} onChange={onFile} className="sr-only" />
            </label>
          )}

          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            loading={busy}
            disabled={!imageSrc || !pixels || busy}
          >
            {busy ? "Saving…" : "Save photo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
