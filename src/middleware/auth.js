import { HttpError } from "../utils/http-error.js";
import { UserModel } from "../models/user.model.js";

// GTD-style identity: provider verification happens at sign-in; subsequent
// requests select the account using its saved ID, not a session credential.
export function createAuthMiddleware(env) {
    return async (request, _response, next) => {
        const userId = request.header("x-user-id")?.trim();
        if (!userId || userId.length > 160) {
            next(new HttpError(401, "A valid x-user-id header is required", "UNAUTHORIZED"));
            return;
        }
        try {
            if ((!env.ALLOW_DEV_AUTH || env.NODE_ENV === "production") && !(await UserModel.exists({ userId }))) {
                throw new HttpError(404, "User not found", "NOT_FOUND");
            }
            request.auth = { userId };
            next();
        } catch (error) {
            next(error);
        }
    };
}
