import { BACKEND_URL } from '../config';

// Cómo se achica cada tipo de imagen antes de subirla. Las fotos de productos: 800 px de
// lado en JPEG, que alcanza para la tarjeta del menú en un celular grande y queda muy por
// debajo del tope del server (MAX_IMAGE_BYTES en domain.js). El logo: más chico y en WebP,
// que a diferencia del JPEG conserva la transparencia.
export const IMAGE_PRESETS = {
  photo: { maxSide: 800, type: 'image/jpeg', quality: 0.8 },
  logo: { maxSide: 400, type: 'image/webp', quality: 0.9 }
};

// Achica la imagen en el navegador antes de subirla: una foto de celular pesa varios MB y
// el server solo acepta 300 KB. Devuelve { mime, data } con la imagen en base64. El mime
// sale del resultado y no del pedido: un navegador que no sabe codificar WebP (Safari
// viejo) devuelve PNG.
export const resizeImage = (file, { maxSide, type, quality } = IMAGE_PRESETS.photo) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(type, quality);
    const [, mime, data] = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    resolve({ mime, data });
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('El archivo no es una imagen que el navegador pueda abrir.'));
  };
  img.src = url;
});

// Sube una imagen (ya elegida por el mostrador) y devuelve su id. El id se asigna después
// al producto (menu-add/menu-update) o al logo (update-settings).
export const uploadImage = async (file, token, preset = IMAGE_PRESETS.photo) => {
  const image = await resizeImage(file, preset);
  const res = await fetch(`${BACKEND_URL}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(image)
  });
  if (!res.ok) throw new Error('No se pudo subir la imagen. Probá con otra.');
  return (await res.json()).id;
};

// Imagen en base64 (la que devuelve la generación con IA) como File, para pasarla por el
// mismo camino que una foto elegida a mano (uploadImage).
export const base64ToFile = (base64, mime, name = 'imagen-ia') => {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new File([bytes], name, { type: mime });
};

// Pide al server una foto generada con IA para un producto. No guarda nada: devuelve
// { mime, data } para mostrar la vista previa. Si falla, tira un Error con el mensaje del
// server (cuota agotada, prompt bloqueado, sin servicio configurado...).
export const generateProductImage = async ({ name, description, category }, token) => {
  const res = await fetch(`${BACKEND_URL}/api/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, description, category })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'No se pudo generar la imagen. Probá de nuevo.');
  return body;
};
