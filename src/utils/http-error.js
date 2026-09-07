export class HttpError extends Error {
    status;
    code;
    constructor(status, message, code = "REQUEST_FAILED") {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "HttpError";
    }
}
