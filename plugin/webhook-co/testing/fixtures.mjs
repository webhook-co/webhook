// Byte-level fixture data for the submission test cases in `test-cases.json`.
//
// WHY THIS IS A MODULE AND NOT PART OF THE JSON. Two of these values are secret-SHAPED — a `whsec_`
// string and a 64-char hex key — so `gitleaks` fires on them by entropy and prefix. This repo's rule
// is to suppress at the source with a same-line `gitleaks:allow`, and to use a fingerprint only for
// history that can no longer be fixed; fingerprints are commit-bound and die on a squash-merge. JSON
// has no comments, so the marker is impossible there. The prose a reviewer reads stays in the JSON;
// the bytes live here, next to it, where the marker works.
//
// NEITHER VALUE IS A CREDENTIAL. The Stripe-shaped one is invented for these fixtures and matches
// nothing. The Adyen one is Adyen's own published worked example, already used the same way in
// `packages/webhooks-spec/src/adapters/w3b-adyen.test.ts`.
//
// AND A SECOND SCANNER READS THIS FILE. GitHub secret scanning is not `gitleaks` and does not honour
// a `gitleaks:allow` marker; on a public repo it raises an alert a maintainer then has to triage by
// hand. Its Stripe partner pattern keys on `whsec_` followed by an unbroken run of alphanumerics, so
// the invented value below is deliberately word-separated by underscores — the same shape as the
// `wrong-secret` value further down, which has always sat in this repo unflagged for that reason.
// The bytes here are arbitrary (nothing verifies against them but the signatures in this file), so
// spending them to stay under the pattern costs nothing. Do NOT apply this trick to a value whose
// exact bytes carry meaning: the published Standard Webhooks vector in
// `packages/webhooks-spec/src/adapters/standard-webhooks.test.ts` is a byte-correctness anchor and
// must keep matching the spec, and the redaction fixture in `packages/sdk-ts/src/redaction.test.ts`
// has to stay secret-shaped or it stops proving that redaction fires. Those are triaged, not edited.

/** Invented for these fixtures; not a credential, and it verifies nothing but the payload below. */
const DOCS_STRIPE_SECRET = "whsec_invented_not_a_real_credential"; // gitleaks:allow
/** Adyen's PUBLIC documentation example HMAC key (not a real secret). */
const ADYEN_EXAMPLE_HEX = "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"; // gitleaks:allow

const STRIPE_BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';
const STRIPE_HEADER = [
  "stripe-signature",
  "t=1790000000,v1=b2c86c547d8fba50666d51411e883663ceab37d2c6f2d227718f82f569a5a9d1",
];

export const FIXTURES = {
  "wrong-secret": {
    provider: "stripe",
    body: STRIPE_BODY,
    headers: [STRIPE_HEADER],
    secrets: ["whsec_a_different_environments_secret0"], // gitleaks:allow
    nowUnix: 1790000060,
  },
  "raw-body-modified": {
    provider: "stripe",
    // Signed as the compact form, presented as the pretty-printed copy a body parser hands back.
    body: '{\n  "amount": 1200,\n  "currency": "eur"\n}',
    headers: [
      [
        "stripe-signature",
        "t=1790000000,v1=1278d72b2820d2072d06b38a2584ae0ac55c938232cf9fc39e6f0196e4608084",
      ],
    ],
    secrets: [DOCS_STRIPE_SECRET],
    nowUnix: 1790000060,
  },
  "timestamp-too-old": {
    provider: "stripe",
    body: STRIPE_BODY,
    headers: [STRIPE_HEADER],
    secrets: [DOCS_STRIPE_SECRET],
    nowUnix: 1790086400, // ~24h after the signed timestamp
  },
  "adyen-forged-batch-item": {
    provider: "adyen",
    // item[0] is Adyen's published worked example; item[1] is authentic-shaped and signed by nobody.
    body: JSON.stringify({
      notificationItems: [
        {
          NotificationRequestItem: {
            pspReference: "7914073381342284",
            merchantAccountCode: "TestMerchant",
            merchantReference: "TestPayment-1407325143704",
            amount: { value: 1130, currency: "EUR" },
            eventCode: "AUTHORISATION",
            success: "true",
            additionalData: { hmacSignature: "coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=" },
          },
        },
        {
          NotificationRequestItem: {
            pspReference: "9999999999999999",
            merchantAccountCode: "TestMerchant",
            merchantReference: "NEVER-HAPPENED-1",
            amount: { value: 500000, currency: "EUR" },
            eventCode: "AUTHORISATION",
            success: "true",
            additionalData: { hmacSignature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
          },
        },
      ],
    }),
    headers: [["content-type", "application/json"]],
    secrets: [ADYEN_EXAMPLE_HEX],
    nowUnix: 1790000000,
  },
  "verifies-when-correct": {
    provider: "stripe",
    body: STRIPE_BODY,
    headers: [STRIPE_HEADER],
    secrets: [DOCS_STRIPE_SECRET],
    nowUnix: 1790000060,
  },
};
