import multer from "multer";
export const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 10 * 1024 * 1024, files: 1, fields: 4}});
