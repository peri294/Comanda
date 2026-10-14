// Generación de la foto de un producto con IA. Es el único módulo que habla con los
// proveedores: el resto del server pide una imagen a partir de un prompt y recibe
// { mime, data } o un error con motivo, sin saber quién la generó.
//
// Proveedores (cada local configura el suyo, ver docs/INSTALACION.md):
// - cloudflare: Workers AI con FLUX.1 schnell. Gratis dentro de la cuota diaria.
// - gemini: API de Gemini (pago por imagen, mejor calidad).
// - fake: imagen fija sin red, solo con DEV_MODE=1 (para los E2E y el CI).
import { decodeImageUpload } from './domain.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-image';
const CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const TIMEOUT_MS = 60_000;

// PNG de 1x1 para el proveedor fake (el mismo que usan los E2E de fotos).
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export class ImageAIError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason; // not_configured | blocked | quota_exceeded | provider_error
  }
}

// Qué proveedor usar según las variables de entorno, o null si no hay ninguno.
// IMAGE_AI_PROVIDER lo fija; si no está, se elige el que tenga sus credenciales.
export const resolveProvider = (env = process.env) => {
  const explicit = env.IMAGE_AI_PROVIDER;
  if (explicit === 'fake') return env.DEV_MODE === '1' ? 'fake' : null;
  const hasCloudflare = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  if (explicit === 'cloudflare') return hasCloudflare ? 'cloudflare' : null;
  if (explicit === 'gemini') return hasGemini ? 'gemini' : null;
  if (hasCloudflare) return 'cloudflare';
  if (hasGemini) return 'gemini';
  return null;
};

// --- Lectura de las respuestas (funciones puras, con unit tests) ---

// Cloudflare: { success, result: { image: base64 }, errors: [{ code, message }] }
export const extractCloudflareImage = (body, status) => {
  const image = body?.result?.image;
  if (typeof image === 'string' && image.length > 0) return { mime: 'image/jpeg', data: image };
  const messages = (body?.errors || []).map(e => `${e.code ?? ''} ${e.message ?? ''}`).join(' ').toLowerCase();
  if (status === 429 || /quota|neuron|limit|exceeded/.test(messages)) throw new ImageAIError('quota_exceeded');
  if (/nsfw|safety|blocked|prohibited/.test(messages)) throw new ImageAIError('blocked');
  throw new ImageAIError('provider_error', `Cloudflare respondió ${status}`);
};

// Gemini (endpoint interactions): la imagen viene en output_image.data o en un bloque
// { type: 'image', data } de un paso del modelo. La documentación no muestra el JSON
// crudo, así que se aceptan las dos formas.
export const extractGeminiImage = (body, status) => {
  const fromOutput = body?.output_image ?? body?.outputImage;
  const candidates = [fromOutput];
  for (const step of body?.steps || []) {
    const content = step?.content ?? step?.model_output?.content ?? step?.modelOutput?.content ?? [];
    for (const block of Array.isArray(content) ? content : []) candidates.push(block);
  }
  const image = candidates.find(c => c && typeof c.data === 'string' && c.data.length > 0 && (!c.type || c.type === 'image'));
  if (image) return { mime: image.mime_type || image.mimeType || 'image/jpeg', data: image.data };

  const errorText = JSON.stringify(body?.error ?? body?.status ?? '').toLowerCase();
  if (status === 429 || /resource_exhausted|quota/.test(errorText)) throw new ImageAIError('quota_exceeded');
  if (status >= 400) throw new ImageAIError('provider_error', `Gemini respondió ${status}`);
  // 200 sin imagen: el modelo se negó (filtro de seguridad) o solo devolvió texto.
  throw new ImageAIError('blocked');
};

// --- Llamadas a los proveedores ---

const postJson = async (url, headers, body) => {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new ImageAIError('provider_error', `Sin respuesta del proveedor: ${err.name}`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

const providers = {
  fake: async () => ({ mime: 'image/png', data: FAKE_PNG.toString('base64') }),

  cloudflare: async (prompt, env) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${CLOUDFLARE_MODEL}`;
    const { status, json } = await postJson(url, { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, { prompt, steps: 4 });
    return extractCloudflareImage(json, status);
  },

  gemini: async (prompt, env) => {
    const { status, json } = await postJson(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      { 'x-goog-api-key': env.GEMINI_API_KEY },
      {
        model: env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_MODEL,
        input: [{ type: 'text', text: prompt }],
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:3', image_size: '1K' }
      }
    );
    return extractGeminiImage(json, status);
  }
};

// Genera la imagen y verifica que de verdad lo sea (mismo control que una foto subida).
// Devuelve { mime, data } con data en base64, listo para mandar al navegador.
export const generateProductImage = async (prompt, env = process.env) => {
  const provider = resolveProvider(env);
  if (!provider) throw new ImageAIError('not_configured');
  const { mime, data } = await providers[provider](prompt, env);
  // El tope de 300 KB es para lo que se guarda; esta imagen todavía no se guarda (el
  // navegador la achica antes de subirla), así que solo se verifica el formato.
  const decoded = decodeImageUpload({ mime, data: Buffer.from(data, 'base64').subarray(0, 64).toString('base64') });
  if (decoded.error === 'unsupported_type' || decoded.error === 'invalid_image') {
    throw new ImageAIError('provider_error', 'El proveedor no devolvió una imagen válida');
  }
  return { mime, data };
};
