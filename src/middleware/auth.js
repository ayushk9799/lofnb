import { HttpError } from "../utils/http-error.js";
export function createAuthMiddleware(env) {
    return (request, _response, next) => {
        if (!env.ALLOW_DEV_AUTH || env.NODE_ENV === "production") {
            next(new HttpError(503, "No production authentication adapter is configured", "AUTH_NOT_CONFIGURED"));
            return;
        }
        const value = request.header("x-user-id")?.trim();
        if (!value || value.length > 160) {
            next(new HttpError(401, "A valid x-user-id header is required", "UNAUTHORIZED"));
            return;
        }
        request.auth = { userId: value };
        next();
    };
}
