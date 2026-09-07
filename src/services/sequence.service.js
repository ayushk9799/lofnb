import { RelationshipModel } from "../models/relationship.model.js";
import { HttpError } from "../utils/http-error.js";
export async function allocateMessageSequence(relationshipId, userId) {
    const relationship = await RelationshipModel.findOneAndUpdate({ _id: relationshipId, userId }, { $inc: { nextSequence: 1 }, $set: { lastMessageAt: new Date() } }, { new: true, projection: { nextSequence: 1 } }).lean();
    if (!relationship)
        throw new HttpError(404, "Relationship not found", "NOT_FOUND");
    return relationship.nextSequence;
}
