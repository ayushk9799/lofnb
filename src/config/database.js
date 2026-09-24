import mongoose from "mongoose";
export async function connectDatabase(uri) {
    mongoose.set("strictQuery", true);
    await mongoose.connect(uri, {
        autoIndex: process.env.NODE_ENV !== "production",
        serverSelectionTimeoutMS: 30_000,
        connectTimeoutMS: 20_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 20,
    });
}
export async function disconnectDatabase() {
    await mongoose.disconnect();
}
