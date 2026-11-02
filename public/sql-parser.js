// Canonical parameter scanner for the workbench, SQL runner and its browser page.
// Pure text processing; execution policy remains in the SQL service.
function isNameStart(char) {
  return /[A-Za-z_]/.test(char || "");
}

function isNameChar(char) {
  return /[A-Za-z0-9_.-]/.test(char || "");
}

function sqlLiteralPart(value) {
  return String(value ?? "").replace(/'/g, "''");
}

export function extractParams(sql) {
  const names = [];
  const seen = new Set();
  let questionIndex = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const add = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1] || "";
    const prev = sql[i - 1] || "";

    if (!inSingle && !inDouble && !inBacktick && !inBlockComment && char === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && char === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (char === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) add(name);
        i = end + 1;
        continue;
      }
    }
    if (char === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) add(name);
        i = end + 2;
        continue;
      }
    }

    if (!inSingle && !inDouble && char === '`' && prev !== "\\") {
      inBacktick = !inBacktick;
      i += 1;
      continue;
    }
    if (!inBacktick && !inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (!inBacktick && !inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && char === "?") {
      questionIndex += 1;
      add(`param${questionIndex}`);
      i += 1;
      continue;
    }
    if (
      !inSingle &&
      !inDouble &&
      !inBacktick &&
      (char === ":" || char === "@") &&
      isNameStart(next) &&
      !/[A-Za-z0-9_:@.]/.test(prev)
    ) {
      let j = i + 1;
      while (j < sql.length && isNameChar(sql[j])) j += 1;
      add(sql.slice(i + 1, j));
      i = j;
      continue;
    }

    i += 1;
  }

  return names;
}

export function substituteParams(sql, params) {
  let out = "";
  let i = 0;
  let questionIndex = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const valueFor = (name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`缺少参数：${name}`);
    }
    return params[name];
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1] || "";
    const prev = sql[i - 1] || "";

    if (!inSingle && !inDouble && !inBacktick && !inBlockComment && char === "-" && next === "-") {
      inLineComment = true;
      out += char + next;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      out += char;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && char === "/" && next === "*") {
      inBlockComment = true;
      out += char + next;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        out += char + next;
        i += 2;
      } else {
        out += char;
        i += 1;
      }
      continue;
    }

    if (char === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
          const value = valueFor(name);
          out += inSingle || inDouble ? sqlLiteralPart(value) : String(value ?? "");
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
          const value = valueFor(name);
          out += inSingle || inDouble ? sqlLiteralPart(value) : String(value ?? "");
          i = end + 2;
          continue;
        }
      }
    }

    if (!inSingle && !inDouble && char === '`' && prev !== "\\") {
      inBacktick = !inBacktick;
      out += char;
      i += 1;
      continue;
    }
    if (!inBacktick && !inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      out += char;
      i += 1;
      continue;
    }
    if (!inBacktick && !inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      out += char;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && char === "?") {
      questionIndex += 1;
      out += String(valueFor(`param${questionIndex}`) ?? "");
      i += 1;
      continue;
    }
    if (
      !inSingle &&
      !inDouble &&
      !inBacktick &&
      (char === ":" || char === "@") &&
      isNameStart(next) &&
      !/[A-Za-z0-9_:@.]/.test(prev)
    ) {
      let j = i + 1;
      while (j < sql.length && isNameChar(sql[j])) j += 1;
      out += String(valueFor(sql.slice(i + 1, j)) ?? "");
      i = j;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}
