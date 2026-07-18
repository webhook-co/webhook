import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const Hello = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      className="bg-surface text-fg items-center justify-center"
      data-theme="dark"
      style={{ fontSize: "5rem" }}
    >
      <span style={{ opacity }}>hello, webhook.co</span>
    </AbsoluteFill>
  );
};
