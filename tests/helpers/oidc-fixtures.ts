/**
 * Phase 29 Plan 03: nock + jose helpers for OIDC tests.
 *
 * Centralizes:
 *   - A test-only RSA keypair (cached at module scope) used to mint ID tokens
 *     and serve a JWKS that openid-client can verify.
 *   - `mintIdToken({ ... })` — produces a signed RS256 ID token whose iss matches
 *     the discovery fixture's `issuer` value by default.
 *   - `installOidcInterceptors({ tokenResponse })` — wires nock so a single
 *     handleCallback round-trip can complete against the discovery fixture.
 *
 * Why a separate helper module: tests for both this plan (oidc-client wrapper)
 * AND later plans (oidc-callback route handler in Plan 6) need the same
 * interceptor stack. Centralizing it here keeps the nock contract in one place.
 */
import { SignJWT, generateKeyPair, exportJWK, type CryptoKey, type JWK } from 'jose';
import nock from 'nock';
import discoveryFixture from '../fixtures/oidc-discovery.json' with { type: 'json' };

// Module-level cache so multiple tests share one keypair. The `kid` is stable so
// the same JWKS satisfies every test in a run; sharing the keypair across tests
// also keeps wallclock low (RSA-2048 generation is ~50–200ms each).
let cached: { privateKey: CryptoKey; publicJwk: JWK } | null = null;

/**
 * Lazily generate a test RSA-2048 keypair and return the private CryptoKey
 * (for signing ID tokens) plus the public JWK (for the mocked JWKS endpoint).
 */
export async function getTestKeys(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  if (cached) return cached;
  // extractable: true on both halves so `exportJWK(publicKey)` can read the
  // material out. The private key never leaves the test process; jose accepts
  // an extractable CryptoKey for SignJWT.
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-key-1';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  cached = { privateKey, publicJwk };
  return cached;
}

/**
 * Mint a signed RS256 ID token with the supplied claims. `iss` defaults to the
 * discovery fixture's issuer so openid-client's iss validation passes without
 * the caller having to mirror that string.
 */
export async function mintIdToken(claims: {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  aud: string;
  nonce?: string;
  iss?: string;
  expiresIn?: string;
}): Promise<string> {
  const { privateKey } = await getTestKeys();
  const payload: Record<string, unknown> = {
    sub: claims.sub,
  };
  if (claims.email !== undefined) payload.email = claims.email;
  if (claims.email_verified !== undefined) payload.email_verified = claims.email_verified;
  if (claims.name !== undefined) payload.name = claims.name;
  if (claims.nonce !== undefined) payload.nonce = claims.nonce;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(claims.iss ?? discoveryFixture.issuer)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(privateKey);
}

/**
 * The discovery document object returned to openid-client. Exposed so tests
 * that want a discovery variant (e.g. without end_session_endpoint) can
 * derive from the canonical fixture rather than re-typing it.
 */
export function getDiscoveryFixture(): typeof discoveryFixture {
  return discoveryFixture;
}

export interface OidcInterceptorOptions {
  /** Override the issuer (defaults to the discovery fixture's issuer). */
  issuer?: string;
  /** The mocked token-endpoint response body. */
  tokenResponse: {
    access_token: string;
    id_token: string;
    token_type: 'Bearer';
    expires_in: number;
  };
  /**
   * Override the discovery document (e.g. to omit `end_session_endpoint`).
   * Defaults to the canonical fixture.
   */
  discoveryOverride?: Record<string, unknown>;
}

/**
 * Install nock interceptors for the OIDC happy-path roundtrip: discovery
 * + JWKS + token endpoint. Returns the issuer host so individual tests can
 * layer additional interceptors (e.g. simulate provider 5xx).
 *
 * Caller is responsible for `nock.cleanAll()` in afterEach.
 */
export async function installOidcInterceptors(
  opts: OidcInterceptorOptions,
): Promise<{ issuer: string }> {
  const discoveryDoc = opts.discoveryOverride ?? discoveryFixture;
  const issuer = opts.issuer ?? (discoveryDoc.issuer as string);
  const issuerOrigin = new URL(issuer).origin;
  const jwksUri = discoveryDoc.jwks_uri as string;
  const jwksOrigin = new URL(jwksUri).origin;
  const tokenUri = discoveryDoc.token_endpoint as string;
  const tokenOrigin = new URL(tokenUri).origin;

  const { publicJwk } = await getTestKeys();

  nock(issuerOrigin)
    .get('/.well-known/openid-configuration')
    .reply(200, discoveryDoc);

  nock(jwksOrigin)
    .get(new URL(jwksUri).pathname)
    .reply(200, { keys: [publicJwk] });

  nock(tokenOrigin)
    .post(new URL(tokenUri).pathname)
    .reply(200, opts.tokenResponse);

  return { issuer };
}
