// Cada mesa tiene un token secreto en su QR (?table=X&t=<token>), y sin él el server no
// deja unirse a la mesa. Los tests lo leen del endpoint de demo, que solo existe fuera
// de producción (igual que /api/test/reset).
const BACKEND = 'http://localhost:3001';

export const tableToken = async (tableId) => {
  const links = await (await fetch(`${BACKEND}/api/demo/table-links`)).json();
  return links.find(l => l.id === String(tableId))?.qrToken;
};

// URL del QR de la mesa, para page.goto()
export const clientUrl = async (tableId) => `/?view=client&table=${tableId}&t=${await tableToken(tableId)}`;

// Une un socket crudo a la mesa con su token, como lo hace ClientView
export const joinTable = async (socket, tableId) => {
  socket.emit('join', { role: `table-${tableId}`, token: await tableToken(tableId) });
};
