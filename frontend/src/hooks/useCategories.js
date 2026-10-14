import { useEffect, useState } from 'react';
import { BACKEND_URL } from '../config';

// Categorías del menú (las administra el Mostrador). Se piden al server, también tras cada
// reconexión (un categories-updated emitido sin conexión se pierde), y se actualizan en
// vivo con categories-updated.
export function useCategories(socket) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    const fetchCategories = () => {
      fetch(`${BACKEND_URL}/api/categories`)
        .then(res => res.json())
        .then(setCategories)
        .catch(err => console.error('Error fetching categories:', err));
    };

    fetchCategories();
    if (!socket) return;
    socket.on('connect', fetchCategories);
    socket.on('categories-updated', setCategories);
    return () => {
      socket.off('connect', fetchCategories);
      socket.off('categories-updated', setCategories);
    };
  }, [socket]);

  return categories;
}
