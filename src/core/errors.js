export class MetisError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "MetisError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) {
    throw new MetisError(code, message, details);
  }
}
