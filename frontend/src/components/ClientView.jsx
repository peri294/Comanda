import React, { useState, useEffect } from 'react';
import { Coffee, ShoppingBag, X, Plus, Minus, CreditCard, DollarSign } from 'lucide-react';

export default function ClientView({ tableId, socket }) {
  const [menu, setMenu] = useState([]);
  const [cart, setCart] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('efectivo');
  const [activeOrder, setActiveOrder] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:3001/api/menu')
      .then(res => res.json())
      .then(data => { setMenu(data); setLoading(false); })
      .catch(err => { console.error(err); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.emit('join', `table-${tableId}`);
    socket.on('order-status-changed', (order) => {
      if (order && order.tableId === tableId) setActiveOrder(order);
    });
    return () => socket.off('order-status-changed');
  }, [socket, tableId]);

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { ...product, quantity: 1 }];
    });
  };

  const submitOrder = () => {
    if (cart.length === 0) return;
    const orderData = {
      tableId,
      items: cart.map(i => ({ productId: i.id, name: i.name, price: i.price, quantity: i.quantity })),
      notes,
      paymentMethod
    };
    if (activeOrder) {
      socket.emit('update-order', { orderId: activeOrder.id, ...orderData });
    } else {
      socket.emit('new-order', orderData);
    }
    setCart([]);
    setIsCartOpen(false);
  };

  if (loading) return <div>Cargando...</div>;

  return (
    <div style={{ padding: '20px' }}>
      <h2>Mesa {tableId}</h2>
      <div className="menu-grid">
        {menu.map(item => (
          <div key={item.id} className="menu-card glass-panel" style={{ padding: '10px' }}>
            <h4>{item.name}</h4>
            <button className="btn-primary" onClick={() => addToCart(item)}>
              <Plus size={14} /> Agregar
            </button>
          </div>
        ))}
      </div>

      <button className="cart-float-btn" onClick={() => setIsCartOpen(true)}>
        <ShoppingBag size={24} />
      </button>

      {isCartOpen && (
        <div className="modal-overlay" onClick={() => setIsCartOpen(false)}>
          <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Tu Pedido</h3>
            <button className="btn-primary" onClick={submitOrder}>
              {activeOrder ? 'Actualizar Pedido' : 'Confirmar y Enviar Pedido'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
