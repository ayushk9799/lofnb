import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isTest = Boolean(process.env.VITEST);

// JSON lines in production (easy to ship to any log service), readable
// output in development, silent under tests.
export const logger = pino({
    level: process.env.LOG_LEVEL || (isTest ? "silent" : "error"),
    redact: ["req.headers.authorization", "req.headers.cookie"],
    ...(!isProduction && !isTest
        ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
        : {}),
});
