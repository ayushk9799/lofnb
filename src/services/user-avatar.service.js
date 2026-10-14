import { UserModel } from "../models/user.model.js";

export async function clearUnuploadedAvatar(user) {
    if (!user?.avatarUrl) return user;
    const prefix = `users/${user.userId.replace(/[^a-zA-Z0-9_-]/g, "_")}/avatar/`;
    if (user.avatarKey?.startsWith(prefix)) return user;
    await UserModel.updateOne(
        { _id: user._id, avatarUrl: user.avatarUrl, avatarKey: user.avatarKey || { $in: ["", null] } },
        { $set: { avatarUrl: "", avatarKey: "" } },
    );
    user.avatarUrl = "";
    user.avatarKey = "";
    return user;
}
