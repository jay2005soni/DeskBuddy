// Dependency-free structural/ref check; use a full OpenAPI linter in backend CI too.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const spec = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
assert.equal(spec.openapi, '3.1.0');
let references = 0;
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    assert.ok(value.$ref.startsWith('#/'), 'Only local schema refs are expected');
    let target = spec;
    for (const part of value.$ref.slice(2).split('/')) {
      target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    assert.ok(target, `Missing schema ref: ${value.$ref}`); references++;
  }
  for (const child of Object.values(value)) visit(child);
}
visit(spec);
let operations = 0;
for (const [path, entry] of Object.entries(spec.paths)) {
  assert.ok(path.startsWith('/'));
  for (const [method, operation] of Object.entries(entry)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    operations++;
    assert.ok(operation.responses && operation.security, `${method} ${path} lacks response/security contract`);
    if (!path.startsWith('/v1/auth/') && path !== '/healthz') assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
  }
}
assert.equal(operations, 15);
console.log(`PASS JSON/OpenAPI structure: ${operations} operations, ${references} valid local refs. No live server tested.`);
