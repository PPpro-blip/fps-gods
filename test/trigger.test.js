import assert from 'node:assert/strict';
import test from 'node:test';
import { WeaponTrigger } from '../client/trigger.js';

// Holding the mouse button may only repeat fire for weapons the server marks
// automatic. Every other weapon fires exactly once per physical click.

test('a held semi-automatic weapon never repeats fire', () => {
  const trigger = new WeaponTrigger();
  trigger.sync('SHOTGUN', false);
  assert.equal(trigger.press(), true);
  assert.equal(trigger.shouldRepeat, false);
  assert.equal(trigger.held, true);
  trigger.release();
  assert.equal(trigger.shouldRepeat, false);
});

test('a held automatic weapon repeats until the button is released', () => {
  const trigger = new WeaponTrigger();
  trigger.sync('SMG', true);
  trigger.press();
  assert.equal(trigger.shouldRepeat, true);
  trigger.release();
  assert.equal(trigger.shouldRepeat, false);
});

test('switching weapons while held requires a fresh trigger pull', () => {
  const trigger = new WeaponTrigger();
  trigger.sync('SMG', true);
  trigger.press();
  assert.equal(trigger.shouldRepeat, true);

  // The server confirms a semi-automatic switch while the button is still down.
  trigger.sync('SNIPER', false);
  assert.equal(trigger.shouldRepeat, false);

  // Switching back to an automatic weapon must not resume fire on its own.
  trigger.sync('LMG', true);
  assert.equal(trigger.shouldRepeat, false);

  trigger.release();
  trigger.press();
  assert.equal(trigger.shouldRepeat, true);
});

test('reset clears input for death, pointer-lock loss, and disconnects', () => {
  const trigger = new WeaponTrigger();
  trigger.sync('MINIGUN', true);
  trigger.press();
  assert.equal(trigger.shouldRepeat, true);
  trigger.reset();
  assert.equal(trigger.held, false);
  assert.equal(trigger.shouldRepeat, false);
});
