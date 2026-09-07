import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { upload } from "../middleware/upload.js";
import { requireObjectId } from "../middleware/error-handler.js";
import { requireOwnedRelationship } from "../services/relationship.service.js";
import { RelationshipModel } from "../models/relationship.model.js";
import { HttpError } from "../utils/http-error.js";

export const mediaRouter = Router({mergeParams: true});
mediaRouter.use(async (req, _res, next) => {
    req.relationship = await requireOwnedRelationship(requireObjectId(req.params.relationshipId, "relationshipId"), req.auth.userId);
    next();
});
async function ensureGallery(relationship) {
    if (relationship.media?.gallery !== undefined) return;
    await relationship.populate("characterId", "gallery");
    await RelationshipModel.updateOne({_id: relationship._id, "media.gallery": {$exists: false}}, {
        $set: {"media.gallery": relationship.characterId.gallery.map(photo => ({_id: photo._id, url: photo.url, caption: photo.caption}))}
    });
}
async function store(req) {
    if (!req.file || !req.file.mimetype.startsWith("image/")) throw new HttpError(400, "Choose an image", "INVALID_FILE_TYPE");
    return req.app.locals.storage.upload({...req.file, mimeType: req.file.mimetype, folder: `relationships/${req.relationship._id}`});
}
async function cleanup(req, key) {
    // Only this relationship's managed objects may be removed; canonical/external assets are shared.
    if (key?.startsWith(`relationships/${req.relationship._id}/`)) {
        await req.app.locals.storage.delete(key).catch(() => console.warn("Media cleanup deferred"));
    }
}
mediaRouter.post("/photos", upload.single("photo"), async (req, res) => {
    const caption = z.string().trim().max(240).parse(req.body?.caption || "Candid moment");
    await ensureGallery(req.relationship);
    const file = await store(req);
    const photo = {_id: new Types.ObjectId(), url: file.url, key: file.key, caption};
    try {
        const result = await RelationshipModel.findOneAndUpdate({_id: req.relationship._id, "media.gallery.99": {$exists: false}}, {$push: {"media.gallery": photo}}, {new:true, runValidators:true});
        if (!result) throw new HttpError(400, "Gallery is limited to 100 photos");
        res.status(201).json({data: {gallery: result.media.gallery}});
    } catch (error) { await cleanup(req, file.key); throw error; }
});
mediaRouter.delete("/photos/:photoId", async (req, res) => {
    const photoId = requireObjectId(req.params.photoId, "photoId");
    await ensureGallery(req.relationship);
    const previous = await RelationshipModel.findOneAndUpdate({_id: req.relationship._id, "media.gallery._id": photoId}, {$pull: {"media.gallery": {_id: photoId}}});
    if (!previous) throw new HttpError(404, "Photo not found");
    await cleanup(req, previous.media.gallery.id(photoId)?.key);
    res.status(204).end();
});
mediaRouter.patch("/avatar", upload.single("avatar"), async (req, res) => {
    const file = await store(req);
    try {
        const previous = await RelationshipModel.findOneAndUpdate({_id: req.relationship._id}, {$set: {"media.avatarUrl": file.url, "media.avatarKey": file.key}}, {runValidators:true});
        if (!previous) throw new HttpError(404, "Relationship not found");
        await cleanup(req, previous.media?.avatarKey);
        res.json({data: {avatarUrl: file.url}});
    } catch (error) { await cleanup(req, file.key); throw error; }
});
