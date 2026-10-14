import { useEffect } from 'react';

// Une el socket a una sala y se vuelve a unir automáticamente si el socket se reconecta
// (Socket.io no restaura la membresía de las salas por sí solo tras una reconexión,
// por lo que sin esto la pantalla queda "conectada" pero sorda a nuevos eventos).
// 'kitchen' y 'counter' requieren el token de sesión del personal; 'table-X', el del QR de la
// mesa y el código de la visita (code), sin el cual el server pide que se ingrese.
export function useSocketRoom(socket, room, token, code) {
  useEffect(() => {
    if (!socket || !room) return;

    const join = () => socket.emit('join', { role: room, token, ...(code && { code }) });
    join();
    socket.on('connect', join);

    return () => socket.off('connect', join);
  }, [socket, room, token, code]);
}
