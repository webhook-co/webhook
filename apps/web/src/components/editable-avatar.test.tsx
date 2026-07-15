import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

// Capture the cropper's props so a test can drive its callbacks without any canvas/react-easy-crop machinery.
let cropperProps: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onUploaded: () => void;
} | null = null;
vi.mock("./avatar-cropper", () => ({
  AvatarCropperDialog: (props: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    onUploaded: () => void;
  }) => {
    cropperProps = props;
    return props.open ? <div data-testid="cropper-open" /> : null;
  },
}));

import { EditableAvatar } from "./editable-avatar";

beforeEach(() => {
  vi.clearAllMocks();
  cropperProps = null;
});
afterEach(cleanup);

describe("EditableAvatar", () => {
  it("opens the cropper when the change-photo control is used", () => {
    render(<EditableAvatar name="Dana" email="dana@acme.co" />);
    expect(screen.queryByTestId("cropper-open")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /change photo/i }));

    expect(screen.getByTestId("cropper-open")).toBeInTheDocument();
  });

  it("cache-busts the avatar and refreshes the route after a successful upload", () => {
    render(<EditableAvatar name="Dana" email="dana@acme.co" />);
    fireEvent.click(screen.getByRole("button", { name: /change photo/i }));

    // Before upload: the canonical, un-versioned URL.
    expect(document.querySelector('img[src="/api/avatar"]')).not.toBeNull();

    act(() => cropperProps!.onUploaded());

    // The <img> URL now carries a version → the browser refetches immediately, and the rest of the app catches
    // up on the router refresh.
    expect(document.querySelector('img[src^="/api/avatar?v="]')).not.toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
