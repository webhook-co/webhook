import { describe, expect, it } from "vitest";

import { CliError } from "../errors.js";
import { EXIT } from "../output/exit-codes.js";
import {
  BackendNotWritableError,
  ConfigNotFoundError,
  CorruptConfigError,
  InsecureConfigPermissionsError,
  SecureStorageRequiredError,
} from "./errors.js";

// Config/store failures are first-class CliErrors so they carry a STABLE exit code (USAGE, not the
// generic UNEXPECTED) and an on-voice `userMessage` the app formatter prints — making `wbhk` scriptable
// against config problems and uniform with every other CLI error.
describe("config errors are first-class CliErrors", () => {
  it("CorruptConfigError → USAGE, with an actionable next step", () => {
    const err = new CorruptConfigError("invalid json");
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.userMessage).toContain("unreadable");
    expect(err.userMessage).toContain("wbhk login");
  });

  it("InsecureConfigPermissionsError → USAGE, naming the exact chmod fix", () => {
    const err = new InsecureConfigPermissionsError(0o644, "/home/u/.config/webhook/config.json");
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.userMessage).toContain("chmod 600 /home/u/.config/webhook/config.json");
  });

  it("SecureStorageRequiredError → USAGE, pointing at WBHK_API_KEY", () => {
    const err = new SecureStorageRequiredError();
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.userMessage).toContain("WBHK_API_KEY");
  });

  it("BackendNotWritableError → USAGE, naming the read-only backend", () => {
    const err = new BackendNotWritableError("env");
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.userMessage).toContain("read-only");
  });

  it("ConfigNotFoundError is a CliError (normally handled as empty by the store)", () => {
    const err = new ConfigNotFoundError();
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});
