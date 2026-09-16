import crypto from "node:crypto";
import { HttpError } from "../utils/http-error.js";

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v2";

export class CurrencyService {
    constructor(env) {
        this.projectId = env?.REVENUECAT_PROJECT_ID;
        this.secretKey = env?.REVENUECAT_SECRET_KEY;
    }

    isConfigured() {
        return Boolean(this.projectId && this.secretKey && !this.secretKey.includes("YOUR_"));
    }

    /**
     * Fetch user's virtual currencies from RevenueCat.
     */
    async getBalances(appUserId) {
        if (!this.isConfigured()) {
            return { GEMS: 0, items: [] };
        }

        const url = `${REVENUECAT_API_BASE}/projects/${this.projectId}/customers/${encodeURIComponent(appUserId)}/virtual_currencies`;
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.secretKey}`,
            },
        });

        if (res.status === 404) {
            return { GEMS: 0, items: [] };
        }

        if (!res.ok) {
            const errorText = await res.text().catch(() => "");
            console.warn(`[CurrencyService] Error fetching balances for ${appUserId}:`, res.status, errorText);
            throw new HttpError(res.status, `Failed to retrieve gems balance: ${res.statusText}`);
        }

        const data = await res.json();
        const items = data?.items || [];
        const gemsItem = items.find((item) => item.currency_code === "GEMS");

        return {
            GEMS: gemsItem ? gemsItem.balance : 0,
            items,
        };
    }

    /**
     * Spend or adjust virtual currency balance.
     * @param {string} appUserId - The customer ID
     * @param {number} amount - Negative to spend (e.g. -5), positive to deposit/grant (e.g. +50)
     * @param {string} [currencyCode="GEMS"]
     * @param {string} [idempotencyKey]
     */
    async adjustBalance(appUserId, amount, currencyCode = "GEMS", idempotencyKey) {
        if (!this.isConfigured()) {
            throw new HttpError(500, "RevenueCat In-App Currency is not configured on server.");
        }

        if (typeof amount !== "number" || Number.isNaN(amount)) {
            throw new HttpError(400, "Invalid adjustment amount");
        }

        const url = `${REVENUECAT_API_BASE}/projects/${this.projectId}/customers/${encodeURIComponent(appUserId)}/virtual_currencies/transactions`;
        const key = idempotencyKey || crypto.randomUUID();

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.secretKey}`,
                "Idempotency-Key": key,
            },
            body: JSON.stringify({
                adjustments: {
                    [currencyCode]: amount,
                },
            }),
        });

        if (res.status === 422) {
            const errData = await res.json().catch(() => ({}));
            throw new HttpError(422, errData.message || "Customer's balance is not enough to perform the transaction.", "INSUFFICIENT_BALANCE");
        }

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new HttpError(res.status, errData.message || `Transaction failed with status ${res.status}`);
        }

        const data = await res.json();
        const items = data?.items || [];
        const updatedItem = items.find((item) => item.currency_code === currencyCode);

        return {
            success: true,
            currencyCode,
            balance: updatedItem ? updatedItem.balance : 0,
            items,
        };
    }
}
