/**
 * Phase 29 Plan 03: tests for the openid-client@6 wrapper.
 *
 * The wrapper centralizes openid-client's functional API behind one project
 * vocabulary. These tests cover:
 *   - initOidc disabled-mode (env var unset) → null
 *   - initOidc happy path → Configuration via mocked discovery
 *   - initOidc discovery failure → typed Error mentioning the issuer URL
 *   - buildAuthorizationUrl emits state + PKCE + scope + redirect_uri
 *   - handleCallback round-trips a code exchange against the nock stack
 *   - buildEndSessionUrl returns a URL when discovery advertised the endpoint
 *   - buildEndSessionUrl returns null when the IdP omits end_session_endpoint
 *
 * Net-connection isolation: every test runs with `nock.disableNetConnect()`
 * and cleans interceptors in afterEach so no state bleeds across tests.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import nock from 'nock';
import {
  initOidc,
  buildAuthorizationUrl,
  handleCallback,
  buildEndSessionUrl,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
  randomState,
} from '../oidc-client.js';
import {
  installOidcInterceptors,
  mintIdToken,
  getDiscoveryFixture,
} from '../../../tests/helpers/oidc-fixtures.js';
import type { Config } from '../../config/env.js';

const ISSUER = 'https://accounts.example.com';
const CLIENT_ID = 'test-client-id.example.com';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://wft.example.com/auth/callback';

/**
 * Minimal Config shape sufficient for the wrapper. Cast through unknown
 * because Config carries fields the wrapper never reads (DB path, ports, etc.)
 * and re-deriving the schema for tests would couple this suite to the env
 * loader's defaults — the wrapper only reads OIDC_* fields.
 */
function makeEnv(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    OIDC_ISSUER_URL: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URI: REDIRECT_URI,
    OIDC_SCOPES: 'openid email profile',
    ...overrides,
  } as unknown as Config;
}

beforeAll(() => {
  // Mirror the project-wide vitest convention: ensure NODE_ENV=test before
  // any module reads it transitively (the env loader bails out of process.exit
  // when NODE_ENV === 'test').
  process.env.NODE_ENV = 'test';
});

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('initOidc', () => {
  it('returns null when OIDC_ISSUER_URL is unset (disabled mode)', async () => {
    const env = makeEnv({ OIDC_ISSUER_URL: undefined });
    const result = await initOidc(env);
    expect(result).toBeNull();
  });

  it('returns null when OIDC_ISSUER_URL is the empty string (disabled mode)', async () => {
    const env = makeEnv({ OIDC_ISSUER_URL: '' as unknown as string });
    const result = await initOidc(env);
    expect(result).toBeNull();
  });

  it('returns a Configuration when discovery succeeds', async () => {
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const env = makeEnv();
    const config = await initOidc(env);
    expect(config).not.toBeNull();
    // Configuration exposes serverMetadata(); use it as the "is this real" probe.
    expect(typeof config?.serverMetadata).toBe('function');
    const meta = config!.serverMetadata();
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.token_endpoint).toBe('https://oauth2.example.com/token');
  });

  it('throws with the issuer URL in the message when discovery returns 500', async () => {
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(500, 'boom');

    const env = makeEnv();
    await expect(initOidc(env)).rejects.toThrow(/OIDC discovery failed/);
    // Issuer URL must be visible in the wrapped message so Plan 8 logs are
    // operator-actionable.
    await expect(initOidc(env)).rejects.toThrow(new RegExp(ISSUER));
  });

  it('throws defensively when OIDC_ISSUER_URL is set but client id/secret missing', async () => {
    const env = makeEnv({ OIDC_CLIENT_ID: undefined, OIDC_CLIENT_SECRET: undefined });
    await expect(initOidc(env)).rejects.toThrow(/OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/);
  });
});

describe('buildAuthorizationUrl', () => {
  it('returns a URL with state, PKCE code_challenge, redirect_uri, and scope', async () => {
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const config = await initOidc(makeEnv());
    expect(config).not.toBeNull();

    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const state = randomState();

    const url = buildAuthorizationUrl(config!, {
      pkceCodeChallenge: codeChallenge,
      state,
      redirectUri: REDIRECT_URI,
      scopes: 'openid email profile',
    });

    expect(url).toBeInstanceOf(URL);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('emits nonce when supplied', async () => {
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const config = await initOidc(makeEnv());
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

    const url = buildAuthorizationUrl(config!, {
      pkceCodeChallenge: codeChallenge,
      state: 'state-xyz',
      nonce: 'nonce-abc',
      redirectUri: REDIRECT_URI,
      scopes: 'openid',
    });
    expect(url.searchParams.get('nonce')).toBe('nonce-abc');
  });
});

describe('handleCallback', () => {
  it('exchanges the code and returns tokens whose claims() yields the ID-token shape', async () => {
    // Pre-mint the ID token because the token endpoint must return it inline.
    const idToken = await mintIdToken({
      sub: 'sub-001',
      email: 'user@example.com',
      email_verified: true,
      name: 'Test User',
      aud: CLIENT_ID,
    });
    const tokenResponse = {
      access_token: 'access-token-001',
      id_token: idToken,
      token_type: 'Bearer' as const,
      expires_in: 3600,
    };
    await installOidcInterceptors({ tokenResponse });

    const config = await initOidc(makeEnv());
    expect(config).not.toBeNull();

    // Build a representative callback URL. openid-client extracts code + state
    // from the query string itself.
    const codeVerifier = randomPKCECodeVerifier();
    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'authcode-001');
    callbackUrl.searchParams.set('state', 'expected-state');

    const tokens = await handleCallback(config!, callbackUrl, {
      pkceVerifier: codeVerifier,
      expectedState: 'expected-state',
    });

    expect(tokens.access_token).toBe('access-token-001');
    expect(tokens.id_token).toBe(idToken);

    const claims = tokens.claims();
    expect(claims).toBeDefined();
    expect(claims!.sub).toBe('sub-001');
    expect(claims!.email).toBe('user@example.com');
    expect(claims!.email_verified).toBe(true);
    expect(claims!.name).toBe('Test User');
    expect(claims!.aud).toBe(CLIENT_ID);
  });

  it('throws on state mismatch', async () => {
    const idToken = await mintIdToken({ sub: 'sub-002', aud: CLIENT_ID });
    await installOidcInterceptors({
      tokenResponse: {
        access_token: 'access-002',
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });

    const config = await initOidc(makeEnv());
    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'authcode-002');
    callbackUrl.searchParams.set('state', 'attacker-state');

    await expect(
      handleCallback(config!, callbackUrl, {
        pkceVerifier: randomPKCECodeVerifier(),
        expectedState: 'expected-state',
      }),
    ).rejects.toThrow();
  });
});

describe('buildEndSessionUrl', () => {
  it('returns a URL with id_token_hint when discovery advertises end_session_endpoint', async () => {
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const config = await initOidc(makeEnv());
    expect(config).not.toBeNull();

    const url = buildEndSessionUrl(config!, {
      idTokenHint: 'opaque-id-token',
      postLogoutRedirectUri: 'https://wft.example.com/auth/login',
    });

    expect(url).not.toBeNull();
    expect(url).toBeInstanceOf(URL);
    expect(url!.searchParams.get('id_token_hint')).toBe('opaque-id-token');
    expect(url!.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://wft.example.com/auth/login',
    );
  });

  it('returns null when discovery did not advertise end_session_endpoint', async () => {
    // Build a discovery variant that omits end_session_endpoint.
    const trimmed: Record<string, unknown> = { ...getDiscoveryFixture() };
    delete trimmed.end_session_endpoint;

    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, trimmed);

    const config = await initOidc(makeEnv());
    expect(config).not.toBeNull();

    const url = buildEndSessionUrl(config!, {
      idTokenHint: 'opaque-id-token',
      postLogoutRedirectUri: 'https://wft.example.com/auth/login',
    });
    expect(url).toBeNull();
  });
});
