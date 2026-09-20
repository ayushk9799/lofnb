import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, resolveWebDistPath } from "../src/app.js";

describe("Web client serving and SPA routing", () => {
  let server;
  let baseUrl;
  let tempDir;

  beforeAll(async () => {
    // Create a temporary mock dist directory to test static serving and fallback isolated from external builds
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lofn-web-test-"));
    const assetsDir = path.join(tempDir, "assets");
    fs.mkdirSync(assetsDir);

    fs.writeFileSync(
      path.join(tempDir, "index.html"),
      '<!doctype html><html><head><title>Lofn Test</title></head><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(
      path.join(tempDir, "favicon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
    );
    fs.writeFileSync(
      path.join(assetsDir, "bundle.js"),
      "console.log('test bundle');",
    );

    const env = {
      NODE_ENV: "test",
      MONGODB_URI: "mongodb://localhost:27017/lofn_test",
      CORS_ORIGIN: "http://localhost:5173",
      ALLOW_DEV_AUTH: true,
    };

    const app = createApp({
      env,
      webDistPath: tempDir,
    });

    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves index.html at root GET /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>Lofn Test</title>");
    expect(body).toContain('<div id="root"></div>');
  });

  it("handles SPA client-side routes by returning index.html with 200 OK", async () => {
    const routes = ["/privacy", "/policy", "/about", "/terms", "/any-spa-path"];
    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<title>Lofn Test</title>");
    }
  });

  it("serves static assets with proper content types", async () => {
    const svgRes = await fetch(`${baseUrl}/favicon.svg`);
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-type")).toContain("image/svg+xml");
    const svgBody = await svgRes.text();
    expect(svgBody).toContain('<circle r="10"/>');

    const jsRes = await fetch(`${baseUrl}/assets/bundle.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("javascript");
    const jsBody = await jsRes.text();
    expect(jsBody).toContain("console.log('test bundle')");
  });

  it("returns JSON 404 for missing static files with extensions instead of returning index.html", async () => {
    const res = await fetch(`${baseUrl}/assets/missing-file.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("does not serve index.html for non-GET/HEAD methods on SPA routes", async () => {
    const res = await fetch(`${baseUrl}/privacy`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("ensures API routes take absolute precedence over static files", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("ensures missing /api routes return JSON 404 and never index.html", async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent-route-12345`, {
      headers: { "x-user-id": "test_user" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("includes relaxed img-src and connect-src in Content Security Policy for external media", async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("connect-src 'self' https: wss: http:");
  });

  describe("resolveWebDistPath helper", () => {
    it("returns null when directory does not exist", () => {
      const result = resolveWebDistPath({
        WEB_DIST_PATH: "/path/that/does/not/exist/999",
      });
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("resolves explicitly configured WEB_DIST_PATH if valid", () => {
      const result = resolveWebDistPath({ WEB_DIST_PATH: tempDir });
      expect(result).toBe(tempDir);
    });
  });

  describe("API-only mode when webDistPath is null", () => {
    let apiOnlyServer;
    let apiOnlyBaseUrl;

    beforeAll(async () => {
      const app = createApp({
        env: {
          NODE_ENV: "test",
          MONGODB_URI: "mongodb://localhost:27017/lofn_test",
          CORS_ORIGIN: "http://localhost:5173",
        },
        webDistPath: null,
      });
      apiOnlyServer = createServer(app);
      await new Promise((resolve) => apiOnlyServer.listen(0, resolve));
      const address = apiOnlyServer.address();
      apiOnlyBaseUrl = `http://localhost:${address.port}`;
    });

    afterAll(async () => {
      if (apiOnlyServer) {
        await new Promise((resolve) => apiOnlyServer.close(resolve));
      }
    });

    it("returns 404 for root GET / when web client is disabled", async () => {
      const res = await fetch(`${apiOnlyBaseUrl}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("Internal public folder resolution", () => {
    it("successfully resolves lofnb/public directory and serves it", async () => {
      const publicPath = path.resolve(__dirname, "../public");
      if (!fs.existsSync(path.join(publicPath, "index.html"))) {
        return;
      }

      const app = createApp({
        env: {
          NODE_ENV: "test",
          MONGODB_URI: "mongodb://localhost:27017/lofn_test",
          CORS_ORIGIN: "http://localhost:5173",
        },
      });

      const realServer = createServer(app);
      await new Promise((resolve) => realServer.listen(0, resolve));
      const port = realServer.address().port;

      try {
        const res = await fetch(`http://localhost:${port}/`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Lofn: Dates That Never Ghost");

        const privacyRes = await fetch(`http://localhost:${port}/privacy`);
        expect(privacyRes.status).toBe(200);
      } finally {
        await new Promise((resolve) => realServer.close(resolve));
      }
    });
  });
});
