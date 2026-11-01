import {afterEach, expect, it, vi} from 'vitest';
import {generateKeyPairSync, sign} from 'node:crypto';
import {verifyAppleToken, verifyGoogleToken} from '../src/services/auth.service.js';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const kid = 'test-apple-provider-key';
const appleToken = claims => {
    const header = Buffer.from(JSON.stringify({alg: 'RS256', kid})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({sub: 'apple-native-user', iss: 'https://appleid.apple.com', aud: 'com.thousandways.lofn', exp: Math.floor(Date.now()/1000)+3600, ...claims})).toString('base64url');
    return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
};
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs();});

it.each(['ios', 'android'])('accepts the server-client audience used by Google sign-in on %s', async () => {
    const audience = '50299044849-tl8kc7h49rcbl5aicfs41eg49tf3bmkn.apps.googleusercontent.com';
    vi.stubEnv('GOOGLE_CLIENT_ID', audience);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok: true, json: async () => ({aud: audience, sub: 'google-native-user', email: 'native@example.com', email_verified: 'true'})});
    expect((await verifyGoogleToken('provider-issued-id-token')).sub).toBe('google-native-user');
});

it('rejects Google tokens for another app', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'expected-audience');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok: true, json: async () => ({aud: 'another-app', sub: 'not-this-app'})});
    await expect(verifyGoogleToken('wrong-app-id-token')).rejects.toMatchObject({code: 'INVALID_TOKEN'});
});

it('verifies a signed iOS Apple token and allows missing name/email on repeat sign-in', async () => {
    vi.stubEnv('APPLE_CLIENT_ID', 'com.thousandways.lofn');
    vi.stubEnv('APPLE_CLIENT_IDS', 'com.thousandways.lofn');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok: true, json: async () => ({keys: [{...publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'}]})});
    const result = await verifyAppleToken(appleToken({}));
    expect(result).toMatchObject({sub: 'apple-native-user', name: '', email: ''});
    await expect(verifyAppleToken(appleToken({exp: 1}))).rejects.toMatchObject({code: 'TOKEN_EXPIRED'});
    await expect(verifyAppleToken(appleToken({aud: 'another-app'}))).rejects.toMatchObject({code: 'INVALID_TOKEN'});
});
