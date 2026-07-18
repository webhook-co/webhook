import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

export const geist = loadGeist("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
export const geistMono = loadGeistMono("normal", { weights: ["400", "500"], subsets: ["latin"] });
