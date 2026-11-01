import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/models/user.model.js", () => ({ UserModel: { updateOne: vi.fn().mockResolvedValue({}) } }));
const { UserModel } = await import("../src/models/user.model.js");
const { createLanguageMiddleware, forgetRememberedLanguages } = await import("../src/middleware/language.js");

function run(headers, userId = "u1") {
    const request = {
        auth: { userId },
        header: name => headers[name.toLowerCase()],
    };
    return new Promise(resolve => createLanguageMiddleware()(request, {}, () => resolve(request)));
}

beforeEach(() => {
    forgetRememberedLanguages();
    UserModel.updateOne.mockClear();
});

it("saves the mobile app's language once and sets request.language", async () => {
    const headers = { "accept-language": "ja", "x-device-language": "ja-JP" };
    expect((await run(headers)).language).toBe("ja");
    await run(headers);
    expect(UserModel.updateOne).toHaveBeenCalledTimes(1);
    expect(UserModel.updateOne).toHaveBeenCalledWith({ userId: "u1", language: { $ne: "ja" } }, { $set: { language: "ja" } });
});

it("saves again when the user switches back and forth", async () => {
    await run({ "accept-language": "ja", "x-device-language": "ja-JP" });
    await run({ "accept-language": "de", "x-device-language": "ja-JP" });
    await run({ "accept-language": "ja", "x-device-language": "ja-JP" });
    expect(UserModel.updateOne.mock.calls.map(call => call[1].$set.language)).toEqual(["ja", "de", "ja"]);
});

it("ignores browsers (no X-Device-Language) and never blocks on a failed save", async () => {
    const web = await run({ "accept-language": "de-DE,de;q=0.9" });
    expect(web.language).toBeUndefined();
    expect(UserModel.updateOne).not.toHaveBeenCalled();
    UserModel.updateOne.mockRejectedValueOnce(new Error("db down"));
    expect((await run({ "accept-language": "ko", "x-device-language": "ko-KR" })).language).toBe("ko");
});
