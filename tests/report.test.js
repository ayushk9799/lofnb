import { describe, expect, it } from "vitest";
import { ReportModel } from "../src/models/report.model.js";

describe("ReportModel Schema", () => {
  it("validates that reason is required", () => {
    const report = new ReportModel({
      userId: "user_test_123",
      contentSnapshot: "Test content",
    });
    const err = report.validateSync();
    expect(err.errors.reason).toBeDefined();
  });

  it("creates a valid report instance with defaults", () => {
    const report = new ReportModel({
      userId: "user_test_123",
      reason: "Gibberish or nonsense",
      details: "Repeated words",
      contentSnapshot: "Hello ???",
    });
    const err = report.validateSync();
    expect(err).toBeUndefined();
    expect(report.status).toBe("pending");
    expect(report.reason).toBe("Gibberish or nonsense");
    expect(report.details).toBe("Repeated words");
  });
});
