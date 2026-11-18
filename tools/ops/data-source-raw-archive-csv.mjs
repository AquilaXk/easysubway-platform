import assert from "node:assert/strict";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];
    if (quoted) {
      const consumed = consumeQuotedCharacter(text, offset);
      field += consumed.value;
      quoted = consumed.quoted;
      offset += consumed.skipped;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      appendCompletedRow(rows, row, field);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  assert.equal(quoted, false, "unterminated quoted CSV field");
  return rows;
}

function consumeQuotedCharacter(text, offset) {
  const character = text[offset];
  if (character !== '"') return { value: character, quoted: true, skipped: 0 };
  if (text[offset + 1] === '"') return { value: '"', quoted: true, skipped: 1 };
  return { value: "", quoted: false, skipped: 0 };
}

function appendCompletedRow(rows, row, field) {
  const completedRow = [...row, field.replace(/\r$/, "")];
  if (completedRow.some((value) => value !== "")) rows.push(completedRow);
}
