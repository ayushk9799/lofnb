import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageService } from "../src/services/storage.service.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=", "base64");
describe("isolated media storage", () => {
    let directory, storage;
    beforeEach(async () => {directory = await fs.mkdtemp(path.join(os.tmpdir(), "lofn-storage-")); storage = new StorageService({}, directory);});
    afterEach(async () => {await fs.rm(directory, {recursive: true, force: true});});
    it("stores detected passive media, ignoring the supplied extension", async () => {
        const file = await storage.upload({buffer:png, originalFilename:"fake.html", mimeType:"image/png"});
        expect(file.key).toMatch(/\.png$/);
        const object = await storage.getObject(file.key);
        const chunks = []; for await (const chunk of object.stream) chunks.push(chunk);
        expect(Buffer.concat(chunks)).toEqual(png);
        expect(object.contentType).toBe("image/png");
        await storage.delete(file.key);
        expect(await storage.getObject(file.key)).toBeNull();
    });
    it.each(["../secret", "/tmp/secret", "x/../../secret", "x\\..\\secret", "x/%2e%2e/secret", "x//secret"])("rejects read/write/delete escape: %s", async key => {
        await expect(storage.getObject(key)).rejects.toThrow();
        await expect(storage.saveLocal(png, key, "image/png")).rejects.toThrow();
        await expect(storage.delete(key)).rejects.toThrow();
    });
    it("rejects a symlink under the storage root", async () => {
        await fs.symlink(os.tmpdir(), path.join(directory, "escape"));
        await expect(storage.saveLocal(png, "escape/file.png", "image/png")).rejects.toThrow();
    });
    it("rejects HTML and SVG disguised as images", async () => {
        await expect(storage.upload({buffer:Buffer.from("<svg onload='alert(1)'/>"), mimeType:"image/png"})).rejects.toThrow();
    });
});
