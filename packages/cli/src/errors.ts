import { EXIT } from "./output/exit-codes.js";

// CLI-level errors carry a stable exit code and a voice-compliant, single-paragraph
// user message (no stack trace, no ANSI). stricli's determineExitCode + error formatting
// read these so failures are scriptable and on-voice.
export abstract class CliError extends Error {
  abstract readonly exitCode: number;
  abstract readonly userMessage: string;
}

export class NotImplementedError extends CliError {
  readonly exitCode = EXIT.NOT_IMPLEMENTED;
  readonly userMessage: string;

  constructor(commandPath: readonly string[], slice: string) {
    const command = ["wbhk", ...commandPath].join(" ");
    super(`command not implemented: ${command}`);
    this.name = "NotImplementedError";
    this.userMessage = `\`${command}\` isn't built yet — it lands in ${slice}. follow the changelog for progress.`;
  }
}
