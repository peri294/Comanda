import React, { useState, useEffect } from 'react';
import { 
  Coffee, ShoppingBag, X, Plus, Minus, CreditCard, 
  DollarSign, CheckCircle, Clock, ChefHat, Bell, LogOut 
} from 'lucide-react';

export default function ClientView({ tableId, socket }) {
  const [menu, setMenu] = useState([]);
  const [filteredMenu, setFilteredMenu] = useState([]);
  const [activeCategory, setActiveCategory] = useState('todos');
  const [cart, setCart] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [notes, setNotes] = useState('');
  
  // Table and Order States from Socket
  const [tableState, setTableState] = useState({
    id: tableId,
    status: 'libre',
    currentOrderId: null,
    paymentMethod: null,
    total: 0
  });
  
  const [activeOrder, setActiveOrder] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch Menu
  useEffect(() => {
    fetch('http://localhost:3001/api/menu')
      .then(res => res.json())
      .then(data => {
        setMenu(data);
        setFilteredMenu(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Error fetching menu:", err);
        setLoading(false);
      });
  }, []);

  // Filter Menu
  useEffect(() => {
    if (activeCategory === 'todos') {
      setFilteredMenu(menu);
    } else {
      setFilteredMenu(menu.filter(item => item.category === activeCategory));
    }
  }, [activeCategory, menu]);

  // Socket Connection and Event Listeners
  useEffect(() => {
    if (!socket) return;

    socket.emit('join', `table-${tableId}`);

    socket.on('table-state', (state) => {
      if (state) {
        setTableState(state);
      }
    });

    socket.on('order-status-changed', (order) => {
      if (order && order.tableId === tableId) {
        setActiveOrder(order);
      }
    });

    socket.on('table-closed', () => {
      setCart([]);
      setActiveOrder(null);
      setNotes('');
      setTableState({
        id: tableId,
        status: 'libre',
        currentOrderId: null,
        paymentMethod: null,
        total: 0
      });
    });

    return () => {
      socket.off('table-state');
      socket.off('order-status-changed');
      socket.off('table-closed');
    };
  }, [socket, tableId]);

  // Add item to cart
  const addToCart = (product) => {
    setCart(prevCart => {
      const existing = prevCart.find(item => item.id === product.id);
      if (existing) {
        return prevCart.map(item => 
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prevCart, { ...product, quantity: 1 }];
    });
  };

  // Modify quantity
  const updateQuantity = (productId, amount) => {
    setCart(prevCart => {
      return prevCart.map(item => {
        if (item.id === productId) {
          const nextQty = item.quantity + amount;
          return nextQty > 0 ? { ...item, quantity: nextQty } : null;
        }
        return item;
      }).filter(Boolean);
    });
  };

  // Cart total
  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  // Send Order
  const submitOrder = () => {
    if (cart.length === 0) return;
    
    const orderData = {
      tableId,
      items: cart.map(item => ({
        productId: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity
      })),
      notes
    };

    socket.emit('new-order', orderData);
    setIsCartOpen(false);
  };

  // Close account (request bill)
  const requestBill = (method) => {
    socket.emit('request-bill', { tableId, paymentMethod: method });
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', flexDirection: 'column', gap: '15px' }}>
        <Coffee size={48} className="status-pedido_pendiente" style={{ animation: 'pulse-glow 1.5s infinite' }} />
        <p style={{ color: 'var(--text-secondary)' }}>Cargando menú delicioso...</p>
      </div>
    );
  }

  // Categories helper
  const categories = [
    { id: 'todos', label: 'Todo' },
    { id: 'bebidas_calientes', label: 'Café Caliente' },
    { id: 'bebidas_frias', label: 'Fríos y Licuados' },
    { id: 'pasteleria', label: 'Pastelería' },
    { id: 'salado', label: 'Salado' }
  ];

  // Map category code to emoji/label
  const categoryEmojis = {
    bebidas_calientes: '☕',
    bebidas_frias: '🍹',
    pasteleria: '🍰',
    salado: '🥪'
  };

  return (
    <div className="animate-fade-in" style={{ paddingBottom: '100px' }}>
      
      {/* Welcome Banner */}
      <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px', textAlign: 'center', position: 'relative' }}>
        <h2 style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--accent-gold)' }}>Mesa {tableId}</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>¡Te damos la bienvenida a nuestra cafetería!</p>
        
        {tableState.status !== 'libre' && (
          <div style={{ marginTop: '16px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <span className={`badge badge-${
              tableState.status === 'pedido_pendiente' ? 'pending' : 
              tableState.status === 'comiendo' ? 'ready' : 
              tableState.status === 'esperando_cuenta' ? 'pending' : 'cooking'
            }`}>
              {tableState.status === 'pedido_pendiente' && <>⌛ Pedido Recibido</>}
              {tableState.status === 'comiendo' && <>🥞 Disfrutando del Servicio</>}
              {tableState.status === 'esperando_cuenta' && <>💵 Esperando al Encargado (Efectivo)</>}
              {tableState.status === 'pagando_tarjeta' && <>💳 Paga en Mostrador con Tarjeta</>}
            </span>
          </div>
        )}
      </div>

      {/* Dynamic Status Dashboard for Active Order */}
      {activeOrder && (
        <div className="glass-panel" style={{ padding: '20px', marginBottom: '24px', borderLeft: '4px solid var(--accent-gold)' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--accent-gold)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ChefHat size={16} /> Estado de tu Pedido
          </h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
            <div>
              <div style={{ fontWeight: 600 }}>Tu orden está: 
                <span style={{ color: 
                  activeOrder.status === 'pendiente' ? 'var(--warning)' :
                  activeOrder.status === 'en_preparacion' ? 'var(--accent-gold)' :
                  activeOrder.status === 'listo' ? 'var(--success)' : 'var(--text-secondary)'
                , marginLeft: '5px' }}>
                  {activeOrder.status === 'pendiente' && 'Esperando aprobación'}
                  {activeOrder.status === 'en_preparacion' && 'En preparación 🍳'}
                  {activeOrder.status === 'listo' && '¡Listo para retirar! ☕'}
                  {activeOrder.status === 'entregado' && 'Entregado'}
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Orden ID: {activeOrder.id.substring(4, 10)}
              </p>
            </div>
            
            <div style={{ display: 'flex', gap: '8px' }}>
              <div className={`badge ${
                activeOrder.status === 'pendiente' ? 'badge-pending' :
                activeOrder.status === 'en_preparacion' ? 'badge-cooking' :
                activeOrder.status === 'listo' ? 'badge-ready' : 'badge-delivered'
              }`}>
                {activeOrder.status === 'pendiente' && <Clock size={12} />}
                {activeOrder.status === 'en_preparacion' && <ChefHat size={12} />}
                {activeOrder.status === 'listo' && <CheckCircle size={12} />}
                {activeOrder.status === 'entregado' && <CheckCircle size={12} />}
                {activeOrder.status}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table Action Controls (Closing Check) */}
      {tableState.status === 'comiendo' && (
        <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px', textAlign: 'center' }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '8px' }}>¿Deseas cerrar tu cuenta?</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.9rem' }}>
            Consumo total actual: <span style={{ fontWeight: 700, color: 'var(--accent-gold)', fontSize: '1.1rem' }}>${tableState.total}</span>
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button className="btn-primary" onClick={() => requestBill('efectivo')}>
              <DollarSign size={16} /> Cerrar en Efectivo
            </button>
            <button className="btn-secondary" onClick={() => requestBill('tarjeta')}>
              <CreditCard size={16} /> Pagar con Tarjeta
            </button>
          </div>
        </div>
      )}

      {/* Screen blocker when waiting for bill confirmation */}
      {(tableState.status === 'esperando_cuenta' || tableState.status === 'pagando_tarjeta') && (
        <div className="glass-panel" style={{ padding: '30px', textAlign: 'center', marginBottom: '24px', border: '1px solid var(--accent-gold)' }}>
          <Bell size={48} className="status-pedido_pendiente" style={{ margin: '0 auto 16px auto', animation: 'pulse-glow 1.5s infinite' }} />
          <h3 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Cuenta Solicitada</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '350px', margin: '8px auto 0 auto' }}>
            {tableState.status === 'esperando_cuenta' 
              ? 'El encargado se acercará a la mesa a traerte la cuenta y cobrar en efectivo.' 
              : 'Acércate al mostrador para realizar el pago con tu tarjeta de débito o crédito.'}
          </p>
          <div style={{ marginTop: '20px', fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>
            Total: ${tableState.total}
          </div>
        </div>
      )}

      {/* Menu and Ordering Interface */}
      {(tableState.status === 'libre' || tableState.status === 'pedido_pendiente' || tableState.status === 'comiendo') && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Nuestro Menú</h3>
          </div>

          {/* Categories Filter Bar */}
          <div className="filter-bar">
            {categories.map(cat => (
              <button 
                key={cat.id} 
                className={`filter-btn ${activeCategory === cat.id ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Menu Grid */}
          <div className="menu-grid">
            {filteredMenu.map(item => (
              <div key={item.id} className="glass-panel menu-card">
                <div className="menu-card-img-container">
                  <div className="menu-card-img-placeholder">
                    {categoryEmojis[item.category] || '☕'}
                  </div>
                </div>
                <div className="menu-card-content">
                  <span className="menu-card-category">
                    {item.category.replace('_', ' ')}
                  </span>
                  <h4 className="menu-card-title">{item.name}</h4>
                  <p className="menu-card-description">{item.description}</p>
                  
                  <div className="menu-card-footer">
                    <span className="menu-card-price">${item.price}</span>
                    <button 
                      className="btn-primary" 
                      style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '0.85rem' }}
                      onClick={() => addToCart(item)}
                    >
                      <Plus size={14} /> Agregar
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Floating Cart Button */}
      {cart.length > 0 && (
        <button className="cart-float-btn" onClick={() => setIsCartOpen(true)}>
          <ShoppingBag size={24} />
          <span className="cart-badge">{cart.reduce((sum, item) => sum + item.quantity, 0)}</span>
        </button>
      )}

      {/* Shopping Cart Modal overlay */}
      {isCartOpen && (
        <div className="modal-overlay" onClick={() => setIsCartOpen(false)}>
          <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShoppingBag size={20} className="status-pedido_pendiente" /> Tu Pedido
              </h3>
              <button className="modal-close" onClick={() => setIsCartOpen(false)}>
                <X size={24} />
              </button>
            </div>

            <div style={{ margin: '15px 0' }}>
              {cart.map(item => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-color)' }}>
                  <div>
                    <h4 style={{ fontWeight: 600 }}>{item.name}</h4>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>${item.price} c/u</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button className="btn-secondary" style={{ padding: '6px', borderRadius: '6px' }} onClick={() => updateQuantity(item.id, -1)}>
                      <Minus size={14} />
                    </button>
                    <span style={{ fontWeight: 700 }}>{item.quantity}</span>
                    <button className="btn-secondary" style={{ padding: '6px', borderRadius: '6px' }} onClick={() => updateQuantity(item.id, 1)}>
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '20px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                Notas especiales para la cocina
              </label>
              <textarea 
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ej. café sin azúcar, medialuna bien caliente..."
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '10px',
                  background: 'rgba(0, 0, 0, 0.2)',
                  border: '1px solid var(--border-color)',
                  color: 'white',
                  fontFamily: 'var(--font-main)',
                  resize: 'vertical',
                  minHeight: '80px',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <span style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Total:</span>
              <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>${cartTotal}</span>
            </div>

            <button 
              className="btn-primary" 
              style={{ width: '100%', marginTop: '20px' }}
              onClick={submitOrder}
            >
              Confirmar y Enviar Pedido
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
