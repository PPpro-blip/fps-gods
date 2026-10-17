import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUNDLES,
  GODS_TIER_UNLOCK_KILLS,
  WEAPONS,
  getBundle,
  getWeapon,
  isBundleUnlocked,
} from '../shared/weapons.js';

// The shared catalog is the single source of truth for gameplay stats. These
// checks keep bundles, models and the GODS TIER unlock contract consistent.
test('every bundle carries exactly three resolvable weapons', () => {
  assert.deepEqual(Object.keys(BUNDLES), ['rusher', 'ghost', 'heavy', 'gods']);
  for (const bundle of Object.values(BUNDLES)) {
    assert.equal(bundle.slots.length, 3, `${bundle.id} must have three slots`);
    for (const weaponId of bundle.slots) {
      const weapon = getWeapon(weaponId);
      assert.equal(weapon.id, weaponId);
      assert.ok(weapon.name && weapon.icon && weapon.blurb, `${weaponId} needs HUD copy`);
    }
  }
});

test('weapon stats cover every server-side branch', () => {
  for (const weapon of Object.values(WEAPONS)) {
    assert.ok(Number.isFinite(weapon.damage), `${weapon.id} damage`);
    assert.ok(Number.isFinite(weapon.fireRateMs), `${weapon.id} fireRateMs`);
    assert.ok(Number.isFinite(weapon.range), `${weapon.id} range`);
    assert.ok(
      ['hitscan', 'melee', 'projectile', 'grenade', 'shield'].includes(weapon.type),
      `${weapon.id} type`,
    );
    if (weapon.type === 'hitscan') assert.equal(typeof weapon.spread, 'number');
    if (weapon.type === 'projectile') {
      assert.ok(weapon.splashRadius > 0 && weapon.splashDamage > 0, `${weapon.id} splash`);
    }
    if (weapon.unlimited) assert.ok(weapon.overheatAfterMs > 0, `${weapon.id} must overheat`);
  }
});

test('GODS TIER unlocks at exactly 30 lifetime kills', () => {
  assert.equal(GODS_TIER_UNLOCK_KILLS, 30);
  assert.equal(BUNDLES.gods.unlockKills, 30);
  assert.equal(isBundleUnlocked('gods', 29), false);
  assert.equal(isBundleUnlocked('gods', 30), true);
  assert.equal(isBundleUnlocked('rusher', 0), true);
  assert.equal(getBundle('heavy').name, 'HEAVY');
  assert.throws(() => getWeapon('nope'), /Unknown weapon/);
  assert.throws(() => getBundle('nope'), /Unknown bundle/);
});

test('the sniper one-shots to the head and the knife one-shots anywhere', () => {
  const sniper = getWeapon('sniper');
  assert.ok(sniper.damage * sniper.headshotMultiplier >= 100, 'sniper headshot must kill');
  assert.ok(sniper.damage < 100, 'sniper body shot leaves a sliver');
  const knife = getWeapon('knife');
  assert.ok(knife.damage >= 100, 'knife must kill in one swing');
  const fist = getWeapon('fist');
  assert.ok(fist.knockback > 0, 'god fist needs knockback');
  const pistol = getWeapon('pistol');
  assert.equal(pistol.tracer, false, 'pistol never draws a tracer');
});
