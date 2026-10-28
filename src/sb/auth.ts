import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256Base64 = (input: string) => createHash('sha256').update(input).digest('base64');

export function createChallenge(): { salt: string; challenge: string } {
  return { salt: randomBytes(32).toString('base64'), challenge: randomBytes(32).toString('base64') };
}

/** Streamer.bot: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function computeAuthentication(password: string, salt: string, challenge: string): string {
  return sha256Base64(sha256Base64(password + salt) + challenge);
}

export function verifyAuthentication(
  password: string,
  salt: string,
  challenge: string,
  supplied: unknown,
): boolean {
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(computeAuthentication(password, salt, challenge));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
