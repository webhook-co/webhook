import { Composition } from "remotion";
import { Promo, PROMO_DURATION_IN_FRAMES } from "./compositions/Promo/Promo";
import { promoSchema } from "./compositions/Promo/schema";
import { PromoMaster } from "./promo/PromoMaster";
import { BrandLockup } from "./scenes/BrandLockup";
import "./index.css";
import "./fonts";

export const RemotionRoot = () => (
  <>
    <Composition
      id="Showcase"
      component={BrandLockup}
      durationInFrames={90}
      fps={30}
      width={1080}
      height={1080}
    />
    <Composition
      id="Promo"
      component={Promo}
      durationInFrames={PROMO_DURATION_IN_FRAMES}
      fps={30}
      width={1080}
      height={1080}
      schema={promoSchema}
      defaultProps={{
        headline: "Ship webhooks faster",
        tagline: "free, signed URLs — replay to localhost",
        theme: "dark",
      }}
    />
    <Composition
      id="promo-master-16x9"
      component={PromoMaster}
      durationInFrames={1800}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ format: "16x9" }}
    />
  </>
);
