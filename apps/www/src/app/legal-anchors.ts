/**
 * The permanent section anchors of the legal documents.
 *
 * ⚠️ **These are a public contract, not an implementation detail.** They get pasted into signed
 * agreements, security questionnaires, and vendor reviews — `webhook.co/dpa#sub-processors` may be
 * cited in a document we cannot edit and did not write. So:
 *
 * - **Append-only.** Add freely. **Never rename, never remove, never re-point an existing id at
 *   different content.** A renamed anchor is a dead external reference that fails silently: the
 *   reader lands at the top of the page and has no idea they're in the wrong place.
 * - **Semantic, never positional.** No `#section-3`, no leading numbers. Our headings *are* numbered
 *   ("9. Limitation of liability"), which is exactly why the id must not be derived from the text —
 *   renumbering a clause on a legal edit would otherwise break every citation to it. (This is a live
 *   bug on other companies' legal pages, which slug straight from the numbered heading.)
 * - If a section is genuinely restructured, leave the old id behind as an alias target rather than
 *   deleting it.
 *
 * `legal-anchors.test.ts` pins every id below against a frozen golden list, so a rename or a removal
 * fails CI loudly instead of quietly breaking someone's contract reference.
 */

export const TERMS_ANCHORS = {
  whoWeAre: "who-we-are",
  whatTheServiceDoes: "what-the-service-does",
  yourAccount: "your-account",
  acceptableUse: "acceptable-use",
  yourDataAndContent: "your-data-and-content",
  billingAndRefunds: "billing-and-refunds",
  availabilityAndSupport: "availability-and-support",
  asIs: "as-is",
  limitationOfLiability: "limitation-of-liability",
  indemnification: "indemnification",
  suspensionAndTermination: "suspension-and-termination",
  changes: "changes",
  intellectualProperty: "intellectual-property",
  governingLaw: "governing-law",
  enterpriseAgreements: "enterprise-agreements",
  general: "general",
} as const;

export const PRIVACY_ANCHORS = {
  whoWeAre: "who-we-are",
  controllerAndProcessor: "controller-and-processor",
  whatWeCollect: "what-we-collect",
  legalBasis: "legal-basis",
  subProcessors: "sub-processors",
  internationalTransfers: "international-transfers",
  retention: "retention",
  yourRights: "your-rights",
  security: "security",
  cookies: "cookies",
  children: "children",
  dataBreaches: "data-breaches",
  californiaResidents: "california-residents",
  changes: "changes",
  contact: "contact",
} as const;

export const DPA_ANCHORS = {
  scope: "scope",
  controllerAndProcessor: "controller-and-processor",
  processingDetails: "processing-details",
  ourObligations: "our-obligations",
  securityMeasures: "security-measures",
  subProcessors: "sub-processors",
  internationalTransfers: "international-transfers",
  assistance: "assistance",
  dataBreaches: "data-breaches",
  returnAndDeletion: "return-and-deletion",
  audits: "audits",
  liability: "liability",
  changes: "changes",
} as const;

export const ACCEPTABLE_USE_ANCHORS = {
  scope: "scope",
  whyThisIsStrict: "why-this-is-strict",
  prohibitedUses: "prohibited-uses",
  regulatedData: "regulated-data",
  monitoring: "monitoring",
  enforcement: "enforcement",
  reportingAbuse: "reporting-abuse",
  changes: "changes",
} as const;

export const SUB_PROCESSORS_ANCHORS = {
  currentSubProcessors: "current-sub-processors",
  changes: "changes",
} as const;

/** Every legal page's anchor set, keyed by its route. */
export const LEGAL_ANCHORS = {
  terms: TERMS_ANCHORS,
  privacy: PRIVACY_ANCHORS,
  dpa: DPA_ANCHORS,
  "acceptable-use": ACCEPTABLE_USE_ANCHORS,
  "sub-processors": SUB_PROCESSORS_ANCHORS,
} as const;

export type LegalRoute = keyof typeof LEGAL_ANCHORS;
