import mongoose from "mongoose";
export async function connectDatabase(uri) {
    mongoose.set("strictQuery", true);
    await mongoose.connect(uri, {
        autoIndex: process.env.NODE_ENV !== "production",
        serverSelectionTimeoutMS: 10_000,
    });
}
export async function disconnectDatabase() {
    await mongoose.disconnect();
}
