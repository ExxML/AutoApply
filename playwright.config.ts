import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"]],
  globalSetup: "./test/globalSetup.ts",
  webServer: {
    command: "node test/server.mjs",
    url: "http://localhost:5501/jobs/plain.html",
    reuseExistingServer: true,
  },
  projects: [
    { name: "e2e", testIgnore: /live\.spec\.ts/ },
    { name: "live", testMatch: /live\.spec\.ts/ },
  ],
});
