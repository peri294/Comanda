import { useEffect } from 'react';

// Une el socket a una sala y se vuelve a unir automáticamente si el socket se reconecta
// (Socket.io no restaura la membresía de las salas por sí solo tras una reconexión,
// por lo que sin esto la pantalla queda "conectada" pero sorda a nuevos eventos).
export function useSocketRoom(socket, room) {
  useEffect(() => {
    if (!socket || !room) return;

    const join = () => socket.emit('join', room);
    join();
    socket.on('connect', join);

    return () => socket.off('connect', join);
  }, [socket, room]);
}
