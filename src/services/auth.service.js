import {
    createPublicKey,
    verify as verifyCryptoSignature,
} from "node:crypto";
import { HttpError } from "../utils/http-error.js";

const DEFAULT_GOOGLE_CLIENT_ID = "50299044849-tl8kc7h49rcbl5aicfs41eg49tf3bmkn.apps.googleusercontent.com";
const DEFAULT_APPLE_CLIENT_ID = "com.thousandways.lofn";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
let appleKeyCache = { expiresAt: 0, keys: [] };

function base64UrlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Buffer.from(str, "base64").toString("utf-8");
}

function base64UrlDecodeBuffer(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Buffer.from(str, "base64");
}

async function getAppleSigningKey(keyId) {
    if (Date.now() >= appleKeyCache.expiresAt) {
        const response = await fetch(APPLE_JWKS_URL);
        if (!response.ok) {
            throw new HttpError(503, "Unable to retrieve Apple signing keys", "AUTH_PROVIDER_UNAVAILABLE");
        }
        const data = await response.json();
        appleKeyCache = {
            keys: Array.isArray(data?.keys) ? data.keys : [],
            expiresAt: Date.now() + 60 * 60 * 1000,
        };
    }
    const jwk = appleKeyCache.keys.find((key) => key.kid === keyId && key.kty === "RSA");
    if (!jwk) {
        // A key rotation can occur inside the cache window; refetch once.
        appleKeyCache.expiresAt = 0;
        const response = await fetch(APPLE_JWKS_URL);
        if (!response.ok) {
            throw new HttpError(503, "Unable to retrieve Apple signing keys", "AUTH_PROVIDER_UNAVAILABLE");
        }
        const data = await response.json();
        appleKeyCache = {
            keys: Array.isArray(data?.keys) ? data.keys : [],
            expiresAt: Date.now() + 60 * 60 * 1000,
        };
    }
    const resolved = appleKeyCache.keys.find((key) => key.kid === keyId && key.kty === "RSA");
    if (!resolved) throw new HttpError(401, "Unknown Apple signing key", "INVALID_TOKEN");
    return createPublicKey({ key: resolved, format: "jwk" });
}

export async function verifyGoogleToken(idToken) {
    if (!idToken || typeof idToken !== "string") {
        throw new HttpError(400, "Google token is required", "BAD_REQUEST");
    }

    // Mock token support strictly for automated test suites
    if (process.env.NODE_ENV === "test" && idToken.startsWith("mock_google_")) {
        const sub = idToken.replace("mock_google_", "");
        return {
            sub,
            email: `${sub}@gmail.com`,
            name: `User ${sub}`,
            avatarUrl: "",
        };
    }

    try {
        const response = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
        );
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new HttpError(401, err.error_description || "Google token verification failed", "INVALID_TOKEN");
        }
        const data = await response.json();
        if (!data.sub) {
            throw new HttpError(401, "Invalid Google token payload", "INVALID_TOKEN");
        }
        const expectedAudience = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
        if (data.aud !== expectedAudience) {
            throw new HttpError(401, "Google token audience mismatch", "INVALID_TOKEN");
        }
        return {
            sub: data.sub,
            email: String(data.email_verified) === "true" ? (data.email || "") : "",
            name: data.name || data.given_name || "",
            avatarUrl: "",
        };
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(401, `Google verification error: ${error.message}`, "INVALID_TOKEN");
    }
}

export async function verifyAppleToken(idToken, displayName = "", email = "") {
    if (!idToken || typeof idToken !== "string") {
        throw new HttpError(400, "Apple token is required", "BAD_REQUEST");
    }

    // Mock token support strictly for automated test suites
    if (process.env.NODE_ENV === "test" && idToken.startsWith("mock_apple_")) {
        const sub = idToken.replace("mock_apple_", "");
        return {
            sub,
            email: email || `${sub}@apple.com`,
            name: displayName || `Apple User ${sub}`,
            avatarUrl: "",
        };
    }

    try {
        const parts = idToken.split(".");
        if (parts.length !== 3) {
            throw new HttpError(400, "Invalid Apple token structure", "BAD_REQUEST");
        }
        const [encodedHeader, encodedPayload, encodedSignature] = parts;
        const header = JSON.parse(base64UrlDecode(encodedHeader));
        const payload = JSON.parse(base64UrlDecode(encodedPayload));
        if (header.alg !== "RS256" || !header.kid) {
            throw new HttpError(401, "Invalid Apple token header", "INVALID_TOKEN");
        }
        const publicKey = await getAppleSigningKey(header.kid);
        const isValidSignature = verifyCryptoSignature(
            "RSA-SHA256",
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            publicKey,
            base64UrlDecodeBuffer(encodedSignature),
        );
        if (!isValidSignature) {
            throw new HttpError(401, "Invalid Apple token signature", "INVALID_TOKEN");
        }
        if (!payload.sub) {
            throw new HttpError(401, "Invalid Apple token payload", "INVALID_TOKEN");
        }
        const expectedAudiences = (process.env.APPLE_CLIENT_IDS || process.env.APPLE_CLIENT_ID || DEFAULT_APPLE_CLIENT_ID)
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (payload.iss !== "https://appleid.apple.com" || !tokenAudiences.some((aud) => expectedAudiences.includes(aud))) {
            throw new HttpError(401, "Apple token issuer or audience mismatch", "INVALID_TOKEN");
        }
        if (!payload.exp || payload.exp * 1000 < Date.now()) {
            throw new HttpError(401, "Apple token expired", "TOKEN_EXPIRED");
        }
        return {
            sub: payload.sub,
            email: payload.email || email || "",
            name: displayName || "",
            avatarUrl: "",
        };
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(401, `Apple verification error: ${error.message}`, "INVALID_TOKEN");
    }
}
