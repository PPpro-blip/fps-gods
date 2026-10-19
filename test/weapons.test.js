import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUNDLE_BY_ID,
  BUNDLE_INFO,
  BUNDLE_UNLOCK_KILLS,
  DEFAULT_BUNDLE_ID,
} from '../shared/bundles.js';
import {
  BUNDLE_IDS,
  BUNDLE_LOADOUTS,
  WEAPONS,
  getWeapon,
  isBundleId,
} from '../server/weaponConfig.js';

// server/weaponConfig.js is the single authoritative combat catalog.
// shared/bundles.js mirrors only presentation copy, so these checks keep both
// sides locked to the same weapon ids, slots, and display names.

test('every presentation bundle maps onto three authoritative weapons', () => {
  assert.deepEqual(BUNDLE_IDS, ['RUSHER', 'GHOST', 'HEAVY', 'GODS_TIER']);
  assert.equal(BUNDLE_INFO.length, BUNDLE_IDS.length);
  assert.equal(DEFAULT_BUNDLE_ID, 'RUSHER');

  for (const bundle of BUNDLE_INFO) {
    const loadout = BUNDLE_LOADOUTS[bundle.id];
    assert.equal(isBundleId(bundle.id), true);
    assert.equal(loadout.length, 3, `${bundle.id} must have three slots`);
    assert.deepEqual(
      loadout.map((weapon) => weapon.id),
      bundle.weapons.map((weapon) => weapon.id),
      `${bundle.id} slot ids must match the authoritative loadout`,
    );
    loadout.forEach((weapon, index) => {
      const presentation = bundle.weapons[index];
      assert.equal(presentation.name, weapon.name, `${weapon.id} display name`);
      assert.equal(presentation.icon, weapon.icon, `${weapon.id} display icon`);
      assert.ok(presentation.role, `${weapon.id} needs HUD role copy`);
    });
  }
});

test('every authoritative weapon declares complete combat metadata', () => {
  assert.equal(Object.keys(WEAPONS).length, 12);
  for (const weapon of Object.values(WEAPONS)) {
    for (const stat of ['damage', 'fireRate', 'magSize', 'reloadTime', 'range', 'spread']) {
      assert.equal(Number.isFinite(weapon[stat]), true, `${weapon.id}.${stat}`);
    }
    assert.ok(
      ['hitscan', 'melee', 'rocket', 'smoke', 'shield'].includes(weapon.behavior),
      `${weapon.id} behavior`,
    );
    assert.equal(typeof weapon.auto, 'boolean', `${weapon.id} must declare automatic fire`);
    if (weapon.behavior === 'rocket') {
      assert.ok(weapon.splashRadius > 0 && weapon.splashDamage > 0, `${weapon.id} splash`);
    }
    if (weapon.unlimitedAmmo) {
      assert.ok(weapon.overheatsAfterMs > 0, `${weapon.id} must overheat`);
      assert.ok(weapon.overheatCooldownMs > 0, `${weapon.id} needs a cooldown`);
    }
  }

  // Held fire is a server-declared property, not a client guess.
  for (const weaponId of ['SHOTGUN', 'KNIFE', 'PISTOL', 'SNIPER', 'SMOKE_GRENADE', 'ROCKET', 'COMBAT_SHIELD', 'RAILGUN']) {
    assert.equal(WEAPONS[weaponId].auto, false, `${weaponId} must be semi-automatic`);
  }
  for (const weaponId of ['SMG', 'LMG', 'MINIGUN', 'GOD_FIST']) {
    assert.equal(WEAPONS[weaponId].auto, true, `${weaponId} must support held fire`);
  }
});

test('GODS TIER unlocks at exactly 30 lifetime kills', () => {
  assert.equal(BUNDLE_UNLOCK_KILLS, 30);
  assert.equal(BUNDLE_BY_ID.GODS_TIER.unlockKills, 30);
  assert.equal(BUNDLE_BY_ID.RUSHER.unlockKills, undefined);
  assert.equal(getWeapon('RAILGUN').piercesCover, true);
  assert.equal(getWeapon('MINIGUN').unlimitedAmmo, true);
  assert.equal(getWeapon('nope'), null);
});

test('the sniper one-shots to the head and the knife one-shots anywhere', () => {
  const sniper = getWeapon('SNIPER');
  assert.ok(sniper.headshotDamage >= 100, 'sniper headshot must kill');
  assert.ok(sniper.damage < 100, 'sniper body shot leaves a sliver');
  const knife = getWeapon('KNIFE');
  assert.ok(knife.damage >= 100, 'knife must kill in one swing');
  const fist = getWeapon('GOD_FIST');
  assert.ok(fist.knockback > 0, 'god fist needs knockback');
  const pistol = getWeapon('PISTOL');
  assert.equal(pistol.tracer, false, 'pistol never draws a tracer');
});
