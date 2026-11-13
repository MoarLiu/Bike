import test from 'node:test';
import assert from 'node:assert/strict';
import { attempt, field, notarizedAssessment, validTeam } from '../scripts/signing-tools.mjs';

test('successful signing command metadata on stderr is retained', () => {
  const result = attempt(process.execPath, ['-e', 'console.error("TeamIdentifier=TEAM123456")']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, '');
  assert.equal(field(result.output, 'TeamIdentifier'), 'TEAM123456');
});
test('Gatekeeper acceptance must identify the notarized Developer ID source', () => {
  assert.equal(notarizedAssessment({ok:true,output:'Bike.app: accepted\nsource=Notarized Developer ID'}),true);
  assert.equal(notarizedAssessment({ok:true,output:'Bike.app: accepted\nsource=Apple System'}),false);
  assert.equal(notarizedAssessment({ok:false,output:'Bike.app: accepted\nsource=Notarized Developer ID'}),false);
  assert.equal(validTeam('TEAM123456'),true);
  assert.equal(validTeam(undefined),false);
});
