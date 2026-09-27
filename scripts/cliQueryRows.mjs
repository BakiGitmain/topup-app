// Rows from `npx supabase db query --linked -o json` output. The CLI may print more than one JSON document (one per
// statement in a multi-statement file) and may add text around them, so this reads every top-level JSON object and
// returns the rows of the LAST one that has them: the scripts always end their SQL with the select they want back.
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
    if (depth === 0 && ch !== '{') continue;
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
  const withRows = docs.filter((d) => d && Array.isArray(d.rows));
  if (withRows.length === 0) throw new Error(`no JSON rows in the CLI output: ${out.slice(0, 400)}`);
  return withRows[withRows.length - 1].rows;
}
