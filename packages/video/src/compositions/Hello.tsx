import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const Hello = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0c0e12",
        color: "#e7ebf1",
        justifyContent: "center",
        alignItems: "center",
        fontSize: "5rem",
      }}
    >
      <span style={{ opacity }}>hello, webhook.co</span>
    </AbsoluteFill>
  );
};
