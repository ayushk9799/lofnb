import { HttpError } from "../utils/http-error.js";
import { verifySessionToken } from "../services/auth.service.js";

export function createAuthMiddleware(env) {
    return (request, _response, next) => {
        const authHeader = request.header("authorization")?.trim();
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.slice(7).trim();
            try {
                const payload = verifySessionToken(token);
                request.auth = { userId: payload.userId, email: payload.email };
                next();
                return;
            } catch (err) {
                next(err);
                return;
            }
        }

        if (!env.ALLOW_DEV_AUTH || env.NODE_ENV === "production") {
            next(new HttpError(503, "No production authentication adapter is configured", "AUTH_NOT_CONFIGURED"));
            return;
        }

        const value = request.header("x-user-id")?.trim();
        if (!value || value.length > 160) {
            next(new HttpError(401, "A valid x-user-id header or Bearer token is required", "UNAUTHORIZED"));
            return;
        }
        request.auth = { userId: value };
        next();
    };
}
