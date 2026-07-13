// `geist/font/*` ships as an ESM directory import that Vite cannot resolve under vitest, and it does real
// next/font work (self-hosting, CSS var emission) that a jsdom test has no use for anyway. The root layout
// imports it, so testing the layout at all requires standing in for it.
//
// Only the `variable` field is consumed (it lands in the <html> className), so that is all this provides.
export const GeistSans = { variable: "--font-geist-sans" };
export const GeistMono = { variable: "--font-geist-mono" };
