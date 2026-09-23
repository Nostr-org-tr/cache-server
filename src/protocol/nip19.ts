/**
 * NIP-19 Bech32 Encoding & Decoding
 *
 * Implements BIP-173 Bech32 encoding/decoding specifically for Nostr identifiers
 * including npub (public keys).
 *
 * Reference: https://github.com/nostr-protocol/nips/blob/master/19.md
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Calculates the Bech32 checksum using the standard BIP-173 polymod algorithm.
 */
function polymod(values: readonly number[]): number {
  let chk = 1;
  for (let p = 0; p < values.length; ++p) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ (values[p] ?? 0);
    for (let i = 0; i < 5; ++i) {
      if ((top >> i) & 1) {
        chk ^= GENERATOR[i] ?? 0;
      }
    }
  }
  return chk;
}

/**
 * Expands the Human Readable Part (HRP) into 5-bit words for checksum calculation.
 */
function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) >> 5);
  }
  ret.push(0);
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) & 31);
  }
  return ret;
}

/**
 * Creates a 6-character BIP-173 checksum for the given HRP and 5-bit data words.
 */
function createChecksum(hrp: string, data: readonly number[]): number[] {
  const values = hrpExpand(hrp).concat(Array.from(data)).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const ret: number[] = [];
  for (let p = 0; p < 6; ++p) {
    ret.push((mod >> (5 * (5 - p))) & 31);
  }
  return ret;
}

/**
 * Verifies the BIP-173 checksum of a Bech32 data array.
 */
function verifyChecksum(hrp: string, data: readonly number[]): boolean {
  return polymod(hrpExpand(hrp).concat(Array.from(data))) === 1;
}

/**
 * Converts numbers between bit sizes (e.g. 8-bit bytes to 5-bit words or vice versa).
 */
function convertBits(
  data: ArrayLike<number>,
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (let p = 0; p < data.length; ++p) {
    const value = data[p] ?? 0;
    if (value < 0 || (value >> fromBits) !== 0) {
      throw new Error('Invalid value for bit conversion');
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error('Invalid padding in bit conversion');
  }
  return ret;
}

/**
 * Converts a hex string into a Uint8Array byte buffer.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex character in string: ${hex}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Converts a Uint8Array byte buffer into a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encodes an HRP and byte array into a Bech32 string.
 */
export function encodeBech32(hrp: string, data: Uint8Array): string {
  const dataWords = convertBits(data, 8, 5, true);
  const checksum = createChecksum(hrp, dataWords);
  const combined = dataWords.concat(checksum);
  let result = `${hrp}1`;
  for (let i = 0; i < combined.length; ++i) {
    const charIndex = combined[i] ?? 0;
    result += CHARSET.charAt(charIndex);
  }
  return result;
}

/**
 * Decodes a Bech32 string into its HRP and raw byte buffer.
 */
export function decodeBech32(bechString: string): { hrp: string; data: Uint8Array } {
  const lower = bechString.toLowerCase();
  const upper = bechString.toUpperCase();
  if (bechString !== lower && bechString !== upper) {
    throw new Error('Mixed-case Bech32 string');
  }

  const str = lower;
  const sep = str.lastIndexOf('1');
  if (sep === -1 || sep === 0 || sep + 7 > str.length) {
    throw new Error('Invalid Bech32 separator position');
  }

  const hrp = str.substring(0, sep);
  const dataChars = str.substring(sep + 1);
  const dataWords: number[] = [];

  for (let i = 0; i < dataChars.length; ++i) {
    const c = dataChars.charAt(i);
    const d = CHARSET.indexOf(c);
    if (d === -1) {
      throw new Error(`Invalid Bech32 character: ${c}`);
    }
    dataWords.push(d);
  }

  if (!verifyChecksum(hrp, dataWords)) {
    throw new Error('Invalid Bech32 checksum');
  }

  // Remove 6-character checksum before bit conversion
  const payloadWords = dataWords.slice(0, -6);
  const bytes = new Uint8Array(convertBits(payloadWords, 5, 8, false));
  return { hrp, data: bytes };
}

/**
 * Encodes a 32-byte (64-character) hex Nostr public key into a NIP-19 `npub1...` string.
 * If the input is already a valid `npub1...` string, it is normalized and returned.
 */
export function encodeNpub(pubkeyHexOrNpub: string): string {
  if (typeof pubkeyHexOrNpub !== 'string') {
    throw new Error('Public key must be a string');
  }

  const trimmed = pubkeyHexOrNpub.trim();
  if (trimmed.toLowerCase().startsWith('npub1')) {
    // Validate by decoding
    const decoded = decodeNpub(trimmed);
    if (decoded.length === 64) {
      return trimmed.toLowerCase();
    }
  }

  if (!HEX_REGEX.test(trimmed)) {
    throw new Error(`Invalid hex public key: "${trimmed}" (must be 64-character hex string)`);
  }

  const bytes = hexToBytes(trimmed);
  return encodeBech32('npub', bytes);
}

/**
 * Decodes a NIP-19 `npub1...` string into a 32-byte (64-character) lowercase hex string.
 */
export function decodeNpub(npub: string): string {
  if (typeof npub !== 'string') {
    throw new Error('npub must be a string');
  }

  const { hrp, data } = decodeBech32(npub.trim());
  if (hrp !== 'npub') {
    throw new Error(`Invalid HRP: expected "npub", got "${hrp}"`);
  }

  if (data.length !== 32) {
    throw new Error(`Invalid npub payload length: expected 32 bytes, got ${data.length}`);
  }

  return bytesToHex(data);
}

/**
 * Encodes a 32-byte (64-character) hex Nostr event ID into a NIP-19 `note1...` string.
 */
export function encodeNote(eventIdHexOrNote: string): string {
  if (typeof eventIdHexOrNote !== 'string') {
    throw new Error('Event ID must be a string');
  }

  const trimmed = eventIdHexOrNote.trim();
  if (trimmed.toLowerCase().startsWith('note1')) {
    const decoded = decodeNote(trimmed);
    if (decoded.length === 64) {
      return trimmed.toLowerCase();
    }
  }

  if (!HEX_REGEX.test(trimmed)) {
    throw new Error(`Invalid hex event ID: "${trimmed}" (must be 64-character hex string)`);
  }

  const bytes = hexToBytes(trimmed);
  return encodeBech32('note', bytes);
}

/**
 * Decodes a NIP-19 `note1...` string into a 32-byte (64-character) lowercase hex event ID.
 */
export function decodeNote(note: string): string {
  if (typeof note !== 'string') {
    throw new Error('note must be a string');
  }

  const { hrp, data } = decodeBech32(note.trim());
  if (hrp !== 'note') {
    throw new Error(`Invalid HRP: expected "note", got "${hrp}"`);
  }

  if (data.length !== 32) {
    throw new Error(`Invalid note payload length: expected 32 bytes, got ${data.length}`);
  }

  return bytesToHex(data);
}

/**
 * Formats a public key (hex or npub) into a shortened human-readable npub representation.
 * Example: `npub182341…e479a5`
 *
 * If the string cannot be converted to a valid npub, falls back to safe truncation.
 */
export function shortenNpub(
  pubkeyOrNpub: string,
  prefixLen = 10,
  suffixLen = 6
): string {
  if (!pubkeyOrNpub || typeof pubkeyOrNpub !== 'string') {
    return '';
  }

  let npubStr: string;
  try {
    npubStr = encodeNpub(pubkeyOrNpub);
  } catch {
    // Fallback if not a 64-char hex key (e.g. mock or invalid key)
    if (pubkeyOrNpub.length <= prefixLen + suffixLen) {
      return pubkeyOrNpub;
    }
    return `${pubkeyOrNpub.slice(0, prefixLen)}…${pubkeyOrNpub.slice(-suffixLen)}`;
  }

  if (npubStr.length <= prefixLen + suffixLen) {
    return npubStr;
  }

  return `${npubStr.slice(0, prefixLen)}…${npubStr.slice(-suffixLen)}`;
}
