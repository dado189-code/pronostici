import test from 'node:test';import assert from 'node:assert/strict';
import {scheduledSlot,SCHEDULE_HOURS} from '../scripts/engine.mjs';
test('scheduler runs only at 14 and 18 Europe/Rome, both with CEST and CET',()=>{
  assert.deepEqual(SCHEDULE_HOURS,[14,18]);
  // Ora legale (UTC+2): 12:17Z=14:17 e 16:17Z=18:17 procedono; 13:17Z=15:17 e 17:17Z=19:17 no.
  assert.equal(scheduledSlot('2026-10-21T12:17:00Z'),true);
  assert.equal(scheduledSlot('2026-10-21T16:17:00Z'),true);
  assert.equal(scheduledSlot('2026-10-21T13:17:00Z'),false);
  assert.equal(scheduledSlot('2026-10-21T17:17:00Z'),false);
  // Ora solare (UTC+1) dopo il 25/10: 13:17Z=14:17 e 17:17Z=18:17 procedono; 12:17Z=13:17 e 16:17Z=17:17 no.
  assert.equal(scheduledSlot('2026-11-03T13:17:00Z'),true);
  assert.equal(scheduledSlot('2026-11-03T17:17:00Z'),true);
  assert.equal(scheduledSlot('2026-11-03T12:17:00Z'),false);
  assert.equal(scheduledSlot('2026-11-03T16:17:00Z'),false);
});
test('exactly two of the four UTC triggers pass on every day around the DST change',()=>{
  for(const day of ['2026-10-24','2026-10-25','2026-10-26','2027-03-27','2027-03-28','2027-03-29']){
    const passed=[12,13,16,17].filter(h=>scheduledSlot(`${day}T${String(h).padStart(2,'0')}:17:00Z`));
    assert.equal(passed.length,2,`${day}: ${passed}`);
  }
});