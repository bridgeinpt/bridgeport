/**
 * Authentication helpers for tests.
 *
 * Generates JWT tokens compatible with BridgePort's authenticate plugin.
 */
import jwt from '@fastify/jwt';
import Fastify from 'fastify';

let tokenSigner: ReturnType<typeof Fastify> | null = null;

async function getTokenSigner() {
  if (!tokenSigner) {
    tokenSigner = Fastify();
    await tokenSigner.register(jwt, {
      secret: process.env.JWT_SECRET!,
    });
    await tokenSigner.ready();
  }
  return tokenSigner;
}

export interface TestTokenPayload {
  id: string;
  email: string;
  role?: string;
}

/**
 * Generate a valid JWT token for test authentication.
 *
 * @param payload - User data to encode in the token
 * @param expiresIn - Token expiry (default '24h')
 * @returns Signed JWT string
 */
export async function generateTestToken(
  payload: TestTokenPayload,
  expiresIn: string = '24h'
): Promise<string> {
  const signer = await getTokenSigner();
  return signer.jwt.sign(
    { id: payload.id, email: payload.email },
    { expiresIn }
  );
}

/**
 * Generate an Authorization header value for test requests.
 */
export async function authHeader(
  payload: TestTokenPayload,
  expiresIn?: string
): Promise<string> {
  const token = await generateTestToken(payload, expiresIn);
  return `Bearer ${token}`;
}

/**
 * Cleanup the token signer instance (call in global teardown if needed).
 */
export async function cleanupTokenSigner(): Promise<void> {
  if (tokenSigner) {
    await tokenSigner.close();
    tokenSigner = null;
  }
}
