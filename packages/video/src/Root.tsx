import { Composition } from "remotion";
import { Hello } from "./compositions/Hello";
import { BrandLockup } from "./scenes/BrandLockup";
import "./index.css";
import "./fonts";

export const RemotionRoot = () => (
  <>
    <Composition
      id="Hello"
      component={Hello}
      durationInFrames={90}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="Showcase"
      component={BrandLockup}
      durationInFrames={90}
      fps={30}
      width={1080}
      height={1080}
    />
  </>
);
