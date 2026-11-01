import { resolveLanguage } from "./language.js";

// Short server-written texts the user can see. Companion lines stay in the
// companions' casual lowercase voice; notification texts use normal casing.
const STRINGS = {
    photoDeclined: {
        en: "not sending one.",
        ja: "それは送らないでおくね。",
        ko: "그건 안 보낼래.",
        de: "schick ich dir nicht.",
        fr: "je t'envoie pas ça.",
        it: "questa non te la mando.",
        es: "esa no te la mando.",
    },
    voiceDeclined: {
        en: "not sending a voice note.",
        ja: "ボイスメッセージは送らないでおくね。",
        ko: "음성 메시지는 안 보낼래.",
        de: "keine sprachnachricht von mir.",
        fr: "pas de vocal pour l'instant.",
        it: "niente vocale per ora.",
        es: "no te voy a mandar audio.",
    },
    photoFailed: {
        en: "couldn't get that photo through just now.",
        ja: "今、写真がうまく送れなかった…",
        ko: "방금 사진이 안 보내졌어.",
        de: "das foto ging gerade nicht durch.",
        fr: "la photo est pas passée là.",
        it: "la foto non è passata adesso.",
        es: "no se pudo enviar la foto ahora.",
    },
    voiceFailed: {
        en: "couldn't get that voice note through just now.",
        ja: "今、ボイスメッセージがうまく送れなかった…",
        ko: "방금 음성 메시지가 안 보내졌어.",
        de: "die sprachnachricht ging gerade nicht durch.",
        fr: "le vocal est pas passé là.",
        it: "il vocale non è passato adesso.",
        es: "no se pudo enviar el audio ahora.",
    },
    pushPhoto: {
        en: "📷 Sent you a photo",
        ja: "📷 写真が届きました",
        ko: "📷 사진을 보냈어요",
        de: "📷 Hat dir ein Foto geschickt",
        fr: "📷 T'a envoyé une photo",
        it: "📷 Ti ha inviato una foto",
        es: "📷 Te envió una foto",
    },
    pushVoice: {
        en: "🎙️ Sent you a voice note",
        ja: "🎙️ ボイスメッセージが届きました",
        ko: "🎙️ 음성 메시지를 보냈어요",
        de: "🎙️ Hat dir eine Sprachnachricht geschickt",
        fr: "🎙️ T'a envoyé un vocal",
        it: "🎙️ Ti ha inviato un vocale",
        es: "🎙️ Te envió un audio",
    },
    pushMessage: {
        en: "Sent you a message",
        ja: "メッセージが届きました",
        ko: "메시지를 보냈어요",
        de: "Hat dir eine Nachricht geschickt",
        fr: "T'a envoyé un message",
        it: "Ti ha inviato un messaggio",
        es: "Te envió un mensaje",
    },
    pushTitle: {
        en: "New message",
        ja: "新しいメッセージ",
        ko: "새 메시지",
        de: "Neue Nachricht",
        fr: "Nouveau message",
        it: "Nuovo messaggio",
        es: "Nuevo mensaje",
    },
};

export function serverText(key, language) {
    const entry = STRINGS[key];
    if (!entry) throw new Error(`Unknown server text: ${key}`);
    return entry[resolveLanguage(language)] || entry.en;
}
