import { MetisError } from "./errors.js";

const MAX_INPUT_BYTES = 16 * 1024;
const VERBS = new Set(["prd", "plan", "run", "resume", "status"]);
const LEXICAL_QUOTES = new Set(["'", '"', "`"]);

function entryError(code, message, details = undefined) {
  return new MetisError(code, message, details);
}

function tokenize(input) {
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index])) index += 1;
    if (index >= input.length) break;

    const start = index;
    let value = "";
    let startsQuoted = false;
    let quote = null;

    while (index < input.length && (quote !== null || !/\s/u.test(input[index]))) {
      const character = input[index];
      if (quote !== null) {
        if (character === quote) {
          quote = null;
          index += 1;
          continue;
        }
        if (character === "\\" && index + 1 < input.length && (input[index + 1] === quote || input[index + 1] === "\\")) {
          value += input[index + 1];
          index += 2;
          continue;
        }
        value += character;
        index += 1;
        continue;
      }

      if (LEXICAL_QUOTES.has(character) && (value.length === 0 || input[index - 1] === "@")) {
        if (value.length === 0) startsQuoted = true;
        quote = character;
        index += 1;
        continue;
      }
      if (character === "\\" && index + 1 < input.length) {
        const next = input[index + 1];
        if (/\s/u.test(next) || LEXICAL_QUOTES.has(next) || next === "\\") {
          value += next;
          index += 2;
          continue;
        }
      }
      value += character;
      index += 1;
    }

    if (quote !== null) {
      throw entryError("SKILL_ENTRY_MALFORMED", "입력의 인용부호 또는 fence가 닫히지 않았습니다.");
    }
    tokens.push({ value, startsQuoted, start, end: index });
  }

  return tokens;
}

function result(mode, objective = null, documentPath = null) {
  return { mode, objective, documentPath };
}

function isWrappedToken(input, token) {
  const raw = input.slice(token.start, token.end);
  return token.startsQuoted && LEXICAL_QUOTES.has(raw[0]) && raw.at(-1) === raw[0];
}

export function parseSkillEntry(input) {
  if (typeof input !== "string") {
    throw entryError("SKILL_ENTRY_INVALID", "skill entry 입력은 문자열이어야 합니다.");
  }
  if (input.includes("\0")) {
    throw entryError("SKILL_ENTRY_NUL", "skill entry 입력에 NUL 문자를 사용할 수 없습니다.");
  }
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw entryError("SKILL_ENTRY_TOO_LARGE", "skill entry 입력은 16KiB를 초과할 수 없습니다.");
  }

  const tokens = tokenize(input);
  if (tokens.length === 0) return result("status");

  const first = tokens[0];
  const firstWord = first.value;
  const isVerb = !first.startsQuoted && VERBS.has(firstWord);

  if (!isVerb) {
    const objective = isWrappedToken(input, first)
      ? [first.value, input.slice(first.end).trim()].filter(Boolean).join(" ")
      : input.trim();
    return result("execute", objective);
  }

  if (firstWord === "run" || firstWord === "resume" || firstWord === "status") {
    if (tokens.length !== 1) {
      throw entryError("SKILL_ENTRY_ARGUMENTS", `${firstWord} 모드에는 인자를 사용할 수 없습니다.`);
    }
    return result(firstWord);
  }

  const rest = tokens.slice(1);
  if (rest.length === 0) {
    throw entryError("SKILL_ENTRY_OBJECTIVE_REQUIRED", `${firstWord} 모드에는 objective 또는 문서 경로가 필요합니다.`);
  }

  const candidate = rest[0];
  if (candidate.value.startsWith("@")) {
    if (candidate.value.length === 1) {
      throw entryError("SKILL_ENTRY_DOCUMENT_INVALID", "문서 경로가 비어 있습니다.");
    }
    if (rest.length > 1) {
      throw entryError("SKILL_ENTRY_DOCUMENT_AMBIGUOUS", "@ 문서 경로가 여러 token으로 나뉘었습니다.");
    }
    return result(firstWord, null, candidate.value.slice(1));
  }

  const rawObjective = input.slice(first.end).trim();
  if (rest.length === 1 && isWrappedToken(input, rest[0])) {
    return result(firstWord, rest[0].value);
  }
  return result(firstWord, rawObjective);
}
