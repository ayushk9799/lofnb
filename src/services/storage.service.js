import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../utils/http-error.js";
import { detectMedia } from "../utils/media.js";
export class StorageService {
    s3Client;
    uploadsDir;
    constructor(env = {}, uploadsDir = path.resolve(process.cwd(), "uploads")) {
        this.env = env;
        this.uploadsDir = uploadsDir;
        if (this.env.R2_ACCOUNT_ID &&
            this.env.R2_ACCESS_KEY_ID &&
            this.env.R2_SECRET_ACCESS_KEY &&
            this.env.R2_BUCKET_NAME) {
            this.s3Client = new S3Client({
                region: "auto",
                endpoint: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: this.env.R2_ACCESS_KEY_ID,
                    secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
                },
                requestChecksumCalculation: "WHEN_REQUIRED",
                responseChecksumValidation: "WHEN_REQUIRED",
            });
        }
    }
    isR2Configured() {
        return Boolean(this.s3Client && this.env.R2_BUCKET_NAME);
    }
    validateKey(key) {
        if (typeof key !== "string" || key.length > 500 || !key.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part))) {
            throw new HttpError(400, "Invalid storage path", "INVALID_STORAGE_KEY");
        }
        return key;
    }
    async localPath(key) {
        this.validateKey(key);
        const target = path.resolve(this.uploadsDir, key);
        if (!target.startsWith(path.resolve(this.uploadsDir) + path.sep)) throw new HttpError(400, "Invalid storage path");
        // Reject symlinks anywhere under the trusted storage root.
        let current = this.uploadsDir;
        for (const part of key.split("/")) {
            current = path.join(current, part);
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) throw new HttpError(400, "Invalid storage path");
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return target;
    }
    async upload({ buffer, mimeType = "application/octet-stream", folder = "gallery", filename }) {
        this.validateKey(folder);
        const media = detectMedia(buffer);
        if (!media || (mimeType.startsWith("image/") && !media.mimeType.startsWith("image/"))) {
            throw new HttpError(400, "Choose a supported image or audio file", "INVALID_FILE_TYPE");
        }
        mimeType = media.mimeType;
        const name = filename ? this.validateKey(filename) : `${randomUUID()}.${media.ext}`;
        const key = `${folder}/${name}`;
        if (this.s3Client && this.env.R2_BUCKET_NAME) {
            try {
                await this.s3Client.send(new PutObjectCommand({
                    Bucket: this.env.R2_BUCKET_NAME,
                    Key: key,
                    Body: buffer,
                    ContentType: mimeType,
                    CacheControl: "public, max-age=31536000, immutable",
                }));
                let url;
                if (this.env.R2_PUBLIC_URL) {
                    url = `${this.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
                }
                else {
                    url = `/api/storage/${key}`;
                }
                return {
                    url,
                    key,
                    size: buffer.length,
                    mimeType,
                    storage: "r2",
                };
            }
            catch (error) {
                throw new HttpError(502, "Media storage is unavailable; please retry", "STORAGE_UNAVAILABLE");
            }
        }
        return this.saveLocal(buffer, key, mimeType);
    }
    async getObject(key) {
        this.validateKey(key);
        if (this.s3Client && this.env.R2_BUCKET_NAME) {
            try {
                const response = await this.s3Client.send(new GetObjectCommand({
                    Bucket: this.env.R2_BUCKET_NAME,
                    Key: key,
                }));
                if (response.Body) {
                    return {
                        stream: response.Body,
                        contentType: response.ContentType,
                        contentLength: response.ContentLength,
                    };
                }
            }
            catch (error) {
                console.warn("[StorageService] R2 GetObject failed:", error instanceof Error ? error.message : error);
            }
        }
        const localPath = await this.localPath(key);
        if (existsSync(localPath)) {
            const stat = await fs.stat(localPath);
            if (!stat.isFile()) return null;
            return {
                stream: createReadStream(localPath),
                contentLength: stat.size,
                contentType: ({png:"image/png",jpg:"image/jpeg",webp:"image/webp",gif:"image/gif",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4",aac:"audio/aac"})[path.extname(key).slice(1)] || "application/octet-stream",
            };
        }
        return null;
    }
    async readBuffer(key, maxBytes = 12 * 1024 * 1024) {
        const object = await this.getObject(key);
        if (!object) throw new HttpError(404, "Media file not found", "MEDIA_NOT_FOUND");
        if (object.contentLength && object.contentLength > maxBytes) {
            object.stream.destroy();
            throw new HttpError(413, "Media file is too large", "MEDIA_TOO_LARGE");
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of object.stream) {
            size += chunk.length;
            if (size > maxBytes) {
                object.stream.destroy();
                throw new HttpError(413, "Media file is too large", "MEDIA_TOO_LARGE");
            }
            chunks.push(chunk);
        }
        return { buffer: Buffer.concat(chunks), mimeType: object.contentType };
    }
    async delete(key) {
        this.validateKey(key);
        if (this.s3Client && this.env.R2_BUCKET_NAME) {
            try {
                await this.s3Client.send(new DeleteObjectCommand({
                    Bucket: this.env.R2_BUCKET_NAME,
                    Key: key,
                }));
            }
            catch (error) {
                console.warn("[StorageService] R2 DeleteObject failed:", error instanceof Error ? error.message : error);
            }
        }
        const localPath = await this.localPath(key);
        if (existsSync(localPath)) {
            await fs.unlink(localPath).catch(() => { });
        }
    }
    async saveLocal(buffer, key, mimeType) {
        const targetPath = await this.localPath(key);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, buffer);
        return {
            url: `/uploads/${key}`,
            key,
            size: buffer.length,
            mimeType,
            storage: "local",
        };
    }
}
