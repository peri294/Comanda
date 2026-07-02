// Corre una sola vez antes de toda la suite (no por test) para no generar la misma
// condición de carrera que se busca evitar: si el reset corriera en el beforeEach de
// cada test, dos tests en paralelo podrían pisarse el pedido a mitad de camino.
export default async function globalSetup() {
  const res = await fetch('http://localhost:3001/api/test/reset', { method: 'POST' });
  if (!res.ok) {
    throw new Error(
      `No se pudo resetear el backend antes de los tests (¿está corriendo en :3001?). Status: ${res.status}`
    );
  }
}
