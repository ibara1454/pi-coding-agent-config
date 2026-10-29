import { RuntimeFailure } from "../../diagnostics/index.ts";
import type { GenerationEffects } from "./types.ts";

const IDENTITY_BYTES = 10;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE32_CHARACTER = 5;
const BASE32_MASK = 31;

/** Encodes eighty unpredictable bits in the native nineteen-character sandbox name budget.
 * @example randomIdentity(effects) returns sixteen lowercase base32 characters.
 */
export function randomIdentity(
  effects: Pick<GenerationEffects, "randomBytes">,
): string {
  const bytes = effects.randomBytes(IDENTITY_BYTES);
  if (bytes.length !== IDENTITY_BYTES) {
    throw new RuntimeFailure(
      "preparation",
      "identity",
      "Invalid random identity source.",
    );
  }
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_BASE32_CHARACTER) {
      bits -= BITS_PER_BASE32_CHARACTER;
      result += "abcdefghijklmnopqrstuvwxyz234567"[
        (value >>> bits) & BASE32_MASK
      ];
    }
  }
  return result;
}
