// Laboratory equivalence only. Production preflight compares RAW metadata.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
function tokens(sql) {
 return (sql.match(/[eE]'(?:\\.|''|[^'])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|\$([a-z_0-9]*)\$[\s\S]*?\$\1\$|[a-z_][a-z0-9_$]*|\d+(?:\.\d+)?|::|<>|!=|>=|<=|\|\||[^\s]/gi)??[])
  .filter(t=>!t.startsWith('--')&&!t.startsWith('/*')).map(t=>t.startsWith("'")||t.startsWith('"')||t.startsWith('$')||/^[eE]'/.test(t)?t:t.toLowerCase());
}
export function sqlFunctionFingerprint(sql) {
 const marker=/\bAS (\$[a-z_0-9]*\$)/i.exec(sql);assert(marker,'Expected pg_get_functiondef dollar body');
 const offset=marker.index+marker[0].length,end=sql.lastIndexOf(marker[1]);assert(end>=offset);
 const body=tokens(sql.slice(offset,end));
 // The optional delimiter after the last statement/block changes no SQL.
 if(body.at(-1)===';')body.pop();
 return createHash('sha256').update(JSON.stringify([tokens(sql.slice(0,marker.index)),body])).digest('hex');
}
