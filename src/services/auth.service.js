import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../utils/http-error.js";

const DEFAULT_SECRET = "lofn-secret-token-key-change-in-production-min32";

function base64UrlEncode(str) {
    return Buffer.from(str)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Buffer.from(str, "base64").toString("utf-8");
}

export function createSessionToken(payload, secret = process.env.SESSION_SECRET || DEFAULT_SECRET) {
    const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const now = Date.now();
    const body = base64UrlEncode(JSON.stringify({
        ...payload,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 30 * 24 * 60 * 60, // 30 days
    }));
    const signature = createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `${header}.${body}.${signature}`;
}

export function verifySessionToken(token, secret = process.env.SESSION_SECRET || DEFAULT_SECRET) {
    if (!token || typeof token !== "string") {
        throw new HttpError(401, "Missing or invalid token", "UNAUTHORIZED");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new HttpError(401, "Malformed token", "INVALID_TOKEN");
    }
    const [header, body, signature] = parts;
    const expectedSignature = createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        throw new HttpError(401, "Invalid token signature", "INVALID_TOKEN");
    }

    try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
            throw new HttpError(401, "Token expired", "TOKEN_EXPIRED");
        }
        return payload;
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(401, "Invalid token payload", "INVALID_TOKEN");
    }
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
        return {
            sub: data.sub,
            email: data.email || "",
            name: data.name || data.given_name || "",
            avatarUrl: data.picture || "",
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
        if (parts.length < 2) {
            throw new HttpError(400, "Invalid Apple token structure", "BAD_REQUEST");
        }
        const payload = JSON.parse(base64UrlDecode(parts[1]));
        if (!payload.sub) {
            throw new HttpError(401, "Invalid Apple token payload", "INVALID_TOKEN");
        }
        if (payload.exp && payload.exp * 1000 < Date.now()) {
            throw new HttpError(401, "Apple token expired", "TOKEN_EXPIRED");
        }
        return {
            sub: payload.sub,
            email: email || payload.email || "",
            name: displayName || "",
            avatarUrl: "",
        };
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(401, `Apple verification error: ${error.message}`, "INVALID_TOKEN");
    }
}
