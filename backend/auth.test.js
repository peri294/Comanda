// Unit tests de sesiones y freno de login (auth.js), con un reloj falso.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { passwordMatches, createSessionStore, createLoginThrottle } from './auth.js';

const fakeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

describe('passwordMatches', () => {
  test('acepta solo la contraseña exacta y en string', () => {
    assert.equal(passwordMatches('mostrador123', 'mostrador123'), true);
    assert.equal(passwordMatches('mostrador12', 'mostrador123'), false);
    assert.equal(passwordMatches('', 'mostrador123'), false);
    assert.equal(passwordMatches(undefined, 'mostrador123'), false);
    assert.equal(passwordMatches(['mostrador123'], 'mostrador123'), false);
  });
});

describe('createSessionStore', () => {
  test('un token vale para su rol hasta que se revoca', () => {
    const sessions = createSessionStore();
    const kitchen = sessions.create('kitchen');
    const counter = sessions.create('counter');
    assert.equal(sessions.roleOf(kitchen), 'kitchen');
    assert.equal(sessions.roleOf(counter), 'counter');
    sessions.revoke(kitchen);
    assert.equal(sessions.roleOf(kitchen), null);
    assert.equal(sessions.roleOf(counter), 'counter');
  });

  test('tokens inexistentes o que no son string no tienen rol', () => {
    const sessions = createSessionStore();
    assert.equal(sessions.roleOf('inventado'), null);
    assert.equal(sessions.roleOf(undefined), null);
    assert.equal(sessions.roleOf({}), null);
  });

  test('revokeAllExcept cierra todas las demás sesiones y conserva la indicada', () => {
    const sessions = createSessionStore();
    const mine = sessions.create('counter');
    const others = [sessions.create('counter'), sessions.create('kitchen'), sessions.create('kitchen')];
    assert.equal(sessions.revokeAllExcept(mine), 3);
    assert.equal(sessions.roleOf(mine), 'counter');
    others.forEach(t => assert.equal(sessions.roleOf(t), null));
    assert.equal(sessions.size, 1);
    assert.equal(sessions.revokeAllExcept(mine), 0);
  });
});

describe('createLoginThrottle', () => {
  const setup = () => {
    const clock = fakeClock();
    return { clock, throttle: createLoginThrottle({ maxFailures: 3, windowMs: 60_000, now: clock.now }) };
  };

  test('bloquea después de maxFailures fallos e informa cuánto falta', () => {
    const { clock, throttle } = setup();
    for (let i = 0; i < 3; i++) {
      assert.equal(throttle.check('ip').allowed, true);
      throttle.fail('ip');
      clock.advance(1000);
    }
    assert.deepEqual(throttle.check('ip'), { allowed: false, retryAfterMs: 57_000 });
    // Otra IP no se ve afectada
    assert.equal(throttle.check('otra-ip').allowed, true);
  });

  test('la ventana se cuenta desde el primer fallo y después se libera', () => {
    const { clock, throttle } = setup();
    for (let i = 0; i < 3; i++) throttle.fail('ip');
    clock.advance(59_999);
    assert.equal(throttle.check('ip').allowed, false);
    clock.advance(1);
    assert.equal(throttle.check('ip').allowed, true);
    // Arranca una ventana nueva: un fallo solo no bloquea
    throttle.fail('ip');
    assert.equal(throttle.check('ip').allowed, true);
  });

  test('un login correcto limpia el contador', () => {
    const { throttle } = setup();
    throttle.fail('ip');
    throttle.fail('ip');
    throttle.succeed('ip');
    throttle.fail('ip');
    throttle.fail('ip');
    assert.equal(throttle.check('ip').allowed, true);
  });

  test('las ventanas vencidas de otras IPs se limpian', () => {
    const { clock, throttle } = setup();
    throttle.fail('a');
    throttle.fail('b');
    clock.advance(60_000);
    throttle.fail('c');
    assert.equal(throttle.size, 1);
  });
});
