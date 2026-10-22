// Error with its own exit code: 2 for wrong usage (unknown option, no terminal), shown without a stack
export class ExitError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.exitCode = code;
  }
}
