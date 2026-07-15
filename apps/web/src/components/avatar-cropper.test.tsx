import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// react-easy-crop is a canvas/DOM component that can't run under jsdom. Stub it: once mounted it reports a
// crop rectangle (as the real one does after the first gesture), so Save has pixels to work with. Report it in
// an effect (ONCE) — reporting during render would loop setPixels → re-render forever.
const { CropperStub } = vi.hoisted(() => ({
  CropperStub: (props: { onCropComplete: (a: unknown, px: unknown) => void }) => {
    // Fire once on mount. Deliberately empty deps: onCropComplete is a fresh arrow each render, so depending on
    // it would re-fire → setPixels → re-render → loop. (The exhaustive-deps rule isn't enabled in this config.)
    const reportRef = React.useRef(props.onCropComplete);
    reportRef.current = props.onCropComplete;
    React.useEffect(() => {
      reportRef.current({}, { x: 1, y: 2, width: 100, height: 100 });
    }, []);
    return null;
  },
}));
vi.mock("react-easy-crop", () => ({ default: CropperStub }));
// next/dynamic(() => import("react-easy-crop")) → hand back the stub directly, no async loader.
vi.mock("next/dynamic", () => ({ default: () => CropperStub }));

const { fileToDataUrl, getCroppedWebp } = vi.hoisted(() => ({
  fileToDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
  getCroppedWebp: vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/webp" })),
}));
vi.mock("@/lib/crop-image", () => ({ fileToDataUrl, getCroppedWebp }));

const { uploadAvatarWebp } = vi.hoisted(() => ({ uploadAvatarWebp: vi.fn() }));
vi.mock("@/lib/avatar-upload", () => ({ uploadAvatarWebp }));

import { AvatarCropperDialog } from "./avatar-cropper";

function open() {
  return render(<AvatarCropperDialog open onOpenChange={onOpenChange} onUploaded={onUploaded} />);
}

const onOpenChange = vi.fn();
const onUploaded = vi.fn();

function chooseFile() {
  const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadAvatarWebp.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("AvatarCropperDialog", () => {
  it("re-encodes the crop and uploads it, then signals success", async () => {
    open();
    chooseFile();

    // Once a file is read into a data: URL, the cropper appears and Save becomes reachable.
    const save = await screen.findByRole("button", { name: /save|use photo|upload/i });
    fireEvent.click(save);

    await waitFor(() => expect(uploadAvatarWebp).toHaveBeenCalledOnce());
    // It uploaded the RE-ENCODED webp blob, not the raw chosen file.
    expect(getCroppedWebp).toHaveBeenCalledWith("data:image/png;base64,AAAA", {
      x: 1,
      y: 2,
      width: 100,
      height: 100,
    });
    const uploaded = uploadAvatarWebp.mock.calls[0][0] as Blob;
    expect(uploaded.type).toBe("image/webp");
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });

  it("uses an injected `upload` transport when given one (the org-logo reuse path)", async () => {
    const upload = vi.fn(async () => ({ ok: true as const }));
    render(
      <AvatarCropperDialog
        open
        onOpenChange={onOpenChange}
        onUploaded={onUploaded}
        upload={upload}
      />,
    );
    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: /save|use photo|upload/i }));

    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    // The injected transport got the re-encoded webp; the DEFAULT avatar transport was NOT used.
    expect((upload.mock.calls[0][0] as Blob).type).toBe("image/webp");
    expect(uploadAvatarWebp).not.toHaveBeenCalled();
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });

  it("shows the server's error and does NOT signal success when the upload fails", async () => {
    uploadAvatarWebp.mockResolvedValue({
      ok: false,
      error: "That image is too large — pick a smaller one.",
    });
    open();
    chooseFile();

    fireEvent.click(await screen.findByRole("button", { name: /save|use photo|upload/i }));

    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("surfaces a decode/encode failure without crashing the dialog", async () => {
    getCroppedWebp.mockRejectedValueOnce(new Error("That image couldn't be decoded."));
    open();
    chooseFile();

    fireEvent.click(await screen.findByRole("button", { name: /save|use photo|upload/i }));

    expect(await screen.findByText(/couldn't be decoded/i)).toBeInTheDocument();
    expect(uploadAvatarWebp).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
