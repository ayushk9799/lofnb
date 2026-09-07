import { RelationshipModel } from "../models/relationship.model.js";
import { HttpError } from "../utils/http-error.js";
export async function requireOwnedRelationship(relationshipId, userId) {
    const relationship = await RelationshipModel.findOne({
        _id: relationshipId,
        userId,
    });
    if (!relationship)
        throw new HttpError(404, "Relationship not found", "NOT_FOUND");
    return relationship;
}
