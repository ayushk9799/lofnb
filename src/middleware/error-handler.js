import { isValidObjectId } from "mongoose";
import { ZodError } from "zod";
import { HttpError } from "../utils/http-error.js";
export function requireObjectId(value, label) {
    if (!isValidObjectId(value)) {
        throw new HttpError(400, `${label} is invalid`, "INVALID_ID");
    }
    return value;
}
export function notFoundHandler(_request, _response, next) {
    next(new HttpError(404, "Route not found", "NOT_FOUND"));
}
export function errorHandler(error, _request, response, _next) {
    if (response.headersSent) { response.destroy(); return; }
    if (error.code === 11000) error = new HttpError(409, "This operation conflicts with an existing record", "CONFLICT");
    if (error.name === "ValidationError" || error.name === "CastError") error = new HttpError(400, "Invalid record data", "VALIDATION_ERROR");
    if (error.name === "MulterError") error = new HttpError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Upload rejected: use one file up to 10 MB", "INVALID_UPLOAD");
    // busboy surfaces a truncated multipart body from the client as a plain Error.
    if (/Unexpected end of form|Malformed part header|Unexpected end of multipart data/i.test(error?.message || "")) {
        error = new HttpError(400, "The upload was interrupted before the file finished sending. Please try again.", "UPLOAD_INTERRUPTED");
    }
    if (error.type === "entity.parse.failed") error = new HttpError(400, "Invalid JSON", "INVALID_JSON");
    if (error.type === "entity.too.large") error = new HttpError(413, "Request is too large", "PAYLOAD_TOO_LARGE");
    if (error instanceof ZodError) {
        response.status(400).json({
            error: {
                code: "VALIDATION_ERROR",
                message: "Request validation failed",
                details: error.issues,
            },
        });
        return;
    }
    if (error instanceof HttpError) {
        response.status(error.status).json({
            error: { code: error.code, message: error.message },
        });
        return;
    }
    console.error(`[${_request.method} ${_request.originalUrl}]`, error);
    const exposeCause = process.env.NODE_ENV !== "production";
    response.status(500).json({
        error: {
            code: "INTERNAL_ERROR",
            message: "An unexpected error occurred",
            ...(exposeCause && error?.message ? { detail: String(error.message).slice(0, 500) } : {}),
        },
    });
}
