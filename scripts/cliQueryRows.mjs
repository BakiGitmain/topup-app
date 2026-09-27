// Rows from `npx supabase db query --linked -o json` output. Depending on the CLI version that is a bare array of rows
// (`[{...}]`) or an object carrying them (`{"rows": [...]}`), possibly more than one document (one per statement) with
// text around them. This reads every top-level JSON document and returns the rows of the LAST one: the scripts always
// end their SQL with the select they want back.
export function rowsFromCliOutput(out) {
  const docs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0 && ch !== '{' && ch !== '[') continue;
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try { docs.push(JSON.parse(out.slice(start, i + 1))); } catch { /* not JSON after all: skip it */ }
      }
    }
  }
  const rows = docs.map((d) => (Array.isArray(d) ? d : Array.isArray(d?.rows) ? d.rows : null)).filter(Boolean);
  if (rows.length === 0) throw new Error(`no JSON rows in the CLI output: ${out.slice(0, 400)}`);
  return rows[rows.length - 1];
}
