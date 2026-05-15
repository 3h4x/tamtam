// Decodes the payload (input/output/error) bytes stored by the Vercel
// Workflow Postgres World. The runtime stores payloads as CBOR-wrapped
// devalue-serialized buffers. The plain `*_jsonb` columns are typically
// null; the bytes live in `*_cbor`.
//
// Decode path:
//   bytea → cbor-x.decode → Uint8Array → TextDecoder → "devl<JSON>"
//                                                       │
//                                                       ▼
//                                                   devalue.parse → value
//
// Returns null on any failure or empty input, so the API layer can fall
// back gracefully.

import { decode as cborDecode } from 'cbor-x';
import { parse as devalueParse } from 'devalue';

export function decodeWorkflowPayload(
  jsonValue: unknown,
  cborBuffer: Buffer | Uint8Array | null,
): unknown {
  if (jsonValue != null) return jsonValue;
  if (!cborBuffer || cborBuffer.length === 0) return null;
  try {
    const decoded = cborDecode(cborBuffer as Buffer);
    // CBOR-decoded value is a Uint8Array containing "devl<payload>".
    if (!(decoded instanceof Uint8Array)) {
      // Fallback: if the runtime ever switches to a direct CBOR payload,
      // return whatever cbor-x produced.
      return decoded ?? null;
    }
    const str = new TextDecoder().decode(decoded);
    if (str.startsWith('devl')) {
      return devalueParse(str.slice(4));
    }
    // Unknown 4-byte format prefix — try raw JSON as a last resort.
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
