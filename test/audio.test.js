import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine } from '../client/audio.js';

// The repository ships no audio files, so every cue is synthesised. A fake
// AudioContext lets the synthesis path run headlessly and proves that playback
// never reaches for a network asset.
function createFakeAudioContext() {
  const state = { nodes: 0, started: 0, resumed: 0, state: 'suspended', currentTime: 0, sampleRate: 44_100 };
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const node = (extra = {}) => {
    state.nodes += 1;
    return { connect: (target) => target, ...extra };
  };
  class FakeContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 44_100;
      this.destination = node();
    }

    get nodes() {
      return state.nodes;
    }

    createGain() {
      return node({ gain: param() });
    }

    createBiquadFilter() {
      return node({ type: 'lowpass', frequency: param(), Q: param() });
    }

    createBuffer(channels, length) {
      const data = new Float32Array(length);
      return { getChannelData: () => data, length };
    }

    createBufferSource() {
      return node({
        buffer: null,
        start() {
          state.started += 1;
        },
        stop() {},
      });
    }

    createOscillator() {
      return node({
        type: 'square',
        frequency: param(),
        start() {
          state.started += 1;
        },
        stop() {},
      });
    }

    resume() {
      state.resumed += 1;
      // Real browsers resume asynchronously; the fake does too so the
      // "suspended context stays silent" case is exercised honestly.
      return Promise.resolve().then(() => {
        this.state = 'running';
      });
    }
  }
  return { AudioContext: FakeContext, state };
}

function withFakeWindow(fake) {
  const previous = globalThis.window;
  globalThis.window = { AudioContext: fake.AudioContext };
  return () => {
    globalThis.window = previous;
  };
}

test('audio stays silent until a user gesture unlocks the context', () => {
  const fake = createFakeAudioContext();
  const restore = withFakeWindow(fake);
  try {
    const audio = new AudioEngine();
    assert.equal(audio.play('shot'), false, 'no context means no sound');
    assert.equal(fake.state.nodes, 0);

    assert.equal(audio.unlock(), true);
    assert.ok(fake.state.nodes > 0, 'unlocking builds the master chain and the noise buffer');
    assert.equal(audio.play('shot'), false, 'a suspended context stays silent');

    return audio.context.resume().then(() => {
      assert.equal(audio.context.state, 'running');
      assert.equal(audio.play('shot'), true);
      assert.ok(fake.state.started >= 1, 'a shot starts at least one synth voice');
      audio.dispose();
    });
  } finally {
    restore();
  }
});

test('every cue synthesises something and shots are rate limited', () => {
  const fake = createFakeAudioContext();
  const restore = withFakeWindow(fake);
  try {
    const audio = new AudioEngine();
    audio.unlock();
    audio.context.state = 'running';

    for (const kind of ['shot', 'hit', 'kill', 'reload', 'empty', 'spawn', 'damage', 'ui']) {
      audio.lastPlayed.clear();
      const played = audio.play(kind, { weaponClass: 'heavy' });
      assert.equal(played, true, `${kind} should be playable`);
    }
    // Unknown kinds must be ignored rather than throwing.
    audio.lastPlayed.clear();
    assert.equal(typeof audio.play('explosion'), 'boolean');

    // Two shots in the same tick: the second is dropped, not stacked.
    audio.lastPlayed.clear();
    assert.equal(audio.play('shot'), true);
    assert.equal(audio.play('shot'), false);

    // A muted engine plays nothing at all.
    audio.enabled = false;
    audio.lastPlayed.clear();
    assert.equal(audio.play('shot'), false);
    audio.dispose();
  } finally {
    restore();
  }
});

test('volume is clamped and applied to the master gain', () => {
  const fake = createFakeAudioContext();
  const restore = withFakeWindow(fake);
  try {
    const audio = new AudioEngine({ volume: 4 });
    assert.equal(audio.volume, 1);
    audio.unlock();
    audio.setVolume(2);
    assert.equal(audio.volume, 1);
    assert.equal(audio.master.gain.value, 1);
    audio.setVolume(-3);
    assert.equal(audio.volume, 0);
    assert.equal(audio.master.gain.value, 0);
    audio.setVolume('nonsense');
    assert.equal(audio.volume, 0);
    audio.dispose();
  } finally {
    restore();
  }
});

test('the engine degrades quietly when the browser has no Web Audio', () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    const audio = new AudioEngine();
    assert.equal(audio.unlock(), false);
    assert.equal(audio.play('shot'), false);
    audio.dispose();
  } finally {
    globalThis.window = previous;
  }
});
