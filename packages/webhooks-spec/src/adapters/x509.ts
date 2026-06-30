// Extract the SubjectPublicKeyInfo (SPKI) DER from an X.509 certificate DER. PayPal and Amazon SNS hand
// the receiver a full PEM CERTIFICATE (not a bare public key), but crypto.subtle.importKey("spki", …) wants
// just the SPKI — so we walk the cert's ASN.1 to the subjectPublicKeyInfo field and return its bytes.
//
// A minimal, fully bounds-checked DER reader: it never throws (returns null on ANY malformation), so a junk
// cert becomes a typed KEY_FETCH_FAILED/SIGNATURE_MISMATCH at the call site rather than an exception on the
// ingest path. We do NOT validate the cert chain/CN/expiry here — the engine's fetch is host-pinned to the
// provider's cert host (the SSRF allowlist), which is the trust anchor; this only parses out the key bytes.

interface Tlv {
  readonly tag: number;
  /** Offset of the first content byte. */
  readonly valueStart: number;
  /** Offset one past the last content byte (= start of the next TLV). */
  readonly valueEnd: number;
}

/** Read one DER TLV at `pos`. null on truncation / unsupported (indefinite or >4-byte) length. */
function readTlv(der: Uint8Array, pos: number): Tlv | null {
  if (pos < 0 || pos + 1 >= der.length) return null;
  const tag = der[pos]!;
  let p = pos + 1;
  let len = der[p]!;
  p += 1;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) return null; // indefinite-length or absurd length-of-length
    len = 0;
    for (let i = 0; i < n; i++) {
      if (p >= der.length) return null;
      len = len * 256 + der[p]!;
      p += 1;
    }
  }
  const valueStart = p;
  const valueEnd = valueStart + len;
  if (valueEnd > der.length) return null;
  return { tag, valueStart, valueEnd };
}

const SEQUENCE = 0x30;
const CONTEXT_0 = 0xa0; // EXPLICIT [0] — the optional TBSCertificate version

/**
 * Return the SubjectPublicKeyInfo DER (the bytes importKey("spki", …) wants) from an X.509 certificate DER,
 * or null on any malformation. Walks:
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 *   TBSCertificate ::= SEQUENCE { [0] version?, serialNumber, signature, issuer, validity, subject,
 *                                 subjectPublicKeyInfo, … }
 * i.e. inside tbsCertificate, skip the optional [0] version then the next 5 fields (serialNumber, signature,
 * issuer, validity, subject); the following field is the SPKI SEQUENCE — return its full TLV bytes.
 */
export function x509SpkiFromDer(certDer: Uint8Array): Uint8Array | null {
  const cert = readTlv(certDer, 0);
  if (cert === null || cert.tag !== SEQUENCE) return null;
  const tbs = readTlv(certDer, cert.valueStart);
  if (tbs === null || tbs.tag !== SEQUENCE) return null;

  let pos = tbs.valueStart;
  const first = readTlv(certDer, pos);
  if (first === null) return null;
  if (first.tag === CONTEXT_0) pos = first.valueEnd; // skip the optional version

  // Skip serialNumber, signature, issuer, validity, subject.
  for (let i = 0; i < 5; i++) {
    const field = readTlv(certDer, pos);
    if (field === null) return null;
    pos = field.valueEnd;
  }

  const spki = readTlv(certDer, pos);
  if (spki === null || spki.tag !== SEQUENCE) return null;
  return certDer.subarray(pos, spki.valueEnd);
}
