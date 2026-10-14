// Unit tests de imageAI.js: elección de proveedor y lectura de las respuestas. No llaman
// a ningún proveedor real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, extractCloudflareImage, extractGeminiImage, generateProductImage, ImageAIError } from './imageAI.js';

const reasonOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ImageAIError);
    return err.reason;
  }
  assert.fail('no tiró error');
};

describe('resolveProvider', () => {
  const cloudflare = { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' };
  const gemini = { GEMINI_API_KEY: 'key' };

  test('sin credenciales no hay proveedor', () => {
    assert.equal(resolveProvider({}), null);
    assert.equal(resolveProvider({ CLOUDFLARE_ACCOUNT_ID: 'acc' }), null);
  });

  test('detecta el que tiene credenciales; con los dos, Cloudflare (el gratuito)', () => {
    assert.equal(resolveProvider(cloudflare), 'cloudflare');
    assert.equal(resolveProvider(gemini), 'gemini');
    assert.equal(resolveProvider({ ...cloudflare, ...gemini }), 'cloudflare');
  });

  test('IMAGE_AI_PROVIDER elige, pero solo si ese proveedor tiene credenciales', () => {
    assert.equal(resolveProvider({ ...cloudflare, ...gemini, IMAGE_AI_PROVIDER: 'gemini' }), 'gemini');
    assert.equal(resolveProvider({ ...cloudflare, IMAGE_AI_PROVIDER: 'gemini' }), null);
  });

  test('el proveedor fake solo existe en desarrollo', () => {
    assert.equal(resolveProvider({ IMAGE_AI_PROVIDER: 'fake', DEV_MODE: '1' }), 'fake');
    assert.equal(resolveProvider({ IMAGE_AI_PROVIDER: 'fake' }), null);
  });
});

describe('extractCloudflareImage', () => {
  test('toma la imagen de result.image', () => {
    assert.deepEqual(extractCloudflareImage({ success: true, result: { image: 'abc' } }, 200), { mime: 'image/jpeg', data: 'abc' });
  });

  test('cuota agotada, contenido bloqueado o error genérico', () => {
    assert.equal(reasonOf(() => extractCloudflareImage({ success: false, errors: [{ code: 3036, message: 'Account limited: daily free allocation of neurons exceeded' }] }, 429)), 'quota_exceeded');
    assert.equal(reasonOf(() => extractCloudflareImage({ success: false, errors: [{ message: 'NSFW content detected' }] }, 400)), 'blocked');
    assert.equal(reasonOf(() => extractCloudflareImage({ success: false, errors: [{ message: 'Authentication error' }] }, 401)), 'provider_error');
    assert.equal(reasonOf(() => extractCloudflareImage({}, 500)), 'provider_error');
  });
});

describe('extractGeminiImage', () => {
  test('toma la imagen de output_image', () => {
    assert.deepEqual(extractGeminiImage({ output_image: { data: 'abc', mime_type: 'image/jpeg' } }, 200), { mime: 'image/jpeg', data: 'abc' });
  });

  test('o de un bloque de imagen dentro de los pasos del modelo', () => {
    const body = {
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'Acá está' }, { type: 'image', data: 'xyz', mime_type: 'image/png' }] }
      ]
    };
    assert.deepEqual(extractGeminiImage(body, 200), { mime: 'image/png', data: 'xyz' });
  });

  test('sin imagen en un 200 es un bloqueo; cuota y errores del proveedor', () => {
    assert.equal(reasonOf(() => extractGeminiImage({ steps: [{ content: [{ type: 'text', text: 'No puedo' }] }] }, 200)), 'blocked');
    assert.equal(reasonOf(() => extractGeminiImage({ error: { status: 'RESOURCE_EXHAUSTED' } }, 429)), 'quota_exceeded');
    assert.equal(reasonOf(() => extractGeminiImage({ error: { status: 'PERMISSION_DENIED' } }, 403)), 'provider_error');
  });
});

describe('generateProductImage', () => {
  test('sin proveedor configurado responde not_configured', async () => {
    await assert.rejects(generateProductImage('un café', {}), (err) => err.reason === 'not_configured');
  });

  test('el proveedor fake devuelve una imagen válida sin red', async () => {
    const image = await generateProductImage('un café', { IMAGE_AI_PROVIDER: 'fake', DEV_MODE: '1' });
    assert.equal(image.mime, 'image/png');
    assert.ok(Buffer.from(image.data, 'base64').subarray(1, 4).toString() === 'PNG');
  });
});
