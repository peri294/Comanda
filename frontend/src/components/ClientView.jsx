import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Coffee, ShoppingBag, X, Plus, Minus, CreditCard,
  DollarSign, CheckCircle, Clock, ChefHat, Bell, Hand, Receipt, ChevronUp, ChevronDown, KeyRound
} from 'lucide-react';
import { useSocketRoom } from '../hooks/useSocketRoom';
import { BACKEND_URL } from '../config';
import { formatPrice } from '../utils/format';
import { imageUrl } from '../config';
import { useCategories } from '../hooks/useCategories';

// Motivos con los que el server rechaza un new-order (ver el acknowledgement en server.js).
const ORDER_ERRORS = {
  table_unavailable: 'Tu mesa ya no está disponible. Escaneá de nuevo el QR de la mesa.',
  table_disabled: 'La mesa no está habilitada para pedir. Consultá al personal.',
  no_valid_items: 'Los productos del carrito ya no están disponibles.'
};

// Código de visita guardado por mesa y QR, para no pedirlo de nuevo al recargar. Si el
// navegador no deja usar localStorage (modo privado estricto), se pide en cada carga.
const visitCodeKey = (tableId, qrToken) => `comanda-visit:${tableId}:${qrToken}`;
const readStoredCode = (tableId, qrToken) => {
  try { return localStorage.getItem(visitCodeKey(tableId, qrToken)) || ''; } catch { return ''; }
};
const storeCode = (tableId, qrToken, code) => {
  try {
    if (code) localStorage.setItem(visitCodeKey(tableId, qrToken), code);
    else localStorage.removeItem(visitCodeKey(tableId, qrToken));
  } catch { /* sin almacenamiento: se vuelve a pedir al recargar */ }
};

// Mismo tope que el server (MAX_NOTES_LENGTH en server.js).
const MAX_NOTES_LENGTH = 300;

// Pantalla completa que reemplaza a la vista de la mesa (mesa no disponible, visita
// terminada o mesa bloqueada).
function Notice({ icon: Icon, iconColor, title, children }) {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh' }}>
      <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', maxWidth: '420px' }}>
        <Icon size={48} style={{ color: iconColor, margin: '0 auto 16px auto' }} />
        <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '8px' }}>{title}</h2>
        <p style={{ color: 'var(--text-secondary)' }}>{children}</p>
      </div>
    </div>
  );
}

export default function ClientView({ tableId, qrToken, socket }) {
  const [menu, setMenu] = useState([]);
  const [activeCategory, setActiveCategory] = useState('todos');
  const categories = useCategories(socket);
  const [cart, setCart] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [sendingOrder, setSendingOrder] = useState(false);
  const [orderError, setOrderError] = useState('');

  // Table and Order States from Socket
  const [tableState, setTableState] = useState({
    id: tableId,
    status: 'libre',
    currentOrderId: null,
    paymentMethod: null,
    total: 0
  });

  // Todos los pedidos de la mesa en la sesión actual, indexados por id (no solo el último),
  // para poder armar "Mi Cuenta Parcial" con el desglose completo.
  const [orders, setOrders] = useState({});
  const [showPartialBill, setShowPartialBill] = useState(false);
  const [loading, setLoading] = useState(true);
  const [assistanceRequested, setAssistanceRequested] = useState(false);

  // Timer local que rehabilita el botón "Llamar al Mozo". Se guarda la referencia para
  // poder cancelarlo/rearmarlo: sin esto, el timer de un llamado anterior podía disparar
  // a destiempo y rehabilitar el botón en medio de un llamado nuevo.
  const assistanceTimerRef = useRef(null);
  const armAssistanceTimer = (ms) => {
    clearTimeout(assistanceTimerRef.current);
    assistanceTimerRef.current = setTimeout(() => setAssistanceRequested(false), ms);
  };
  useEffect(() => () => clearTimeout(assistanceTimerRef.current), []);

  // La mesa no existe en el backend o el token del QR no es el suyo (QR viejo de una
  // mesa dada de baja o regenerada, URL armada a mano): se bloquea toda la vista en vez
  // de dejar pedir a una mesa fantasma.
  const [tableUnavailable, setTableUnavailable] = useState(false);

  // El Mostrador cobró la mesa: el server desconecta a todos sus celulares y la visita
  // termina. Para volver a pedir hay que escanear el QR de nuevo (recargar la página).
  const [visitEnded, setVisitEnded] = useState(false);

  // Código de la visita (lo da el mozo; en la demo viene en el link como ?c=). Sin el
  // código vigente el server no deja entrar a la mesa y pide que se ingrese.
  const [visitCode, setVisitCode] = useState(
    () => new URLSearchParams(window.location.search).get('c') || readStoredCode(tableId, qrToken)
  );
  // Para el handler de table-state, que se registra una sola vez: guarda el código que el
  // server acaba de aceptar.
  const visitCodeRef = useRef(visitCode);
  useEffect(() => { visitCodeRef.current = visitCode; }, [visitCode]);
  const [needsCode, setNeedsCode] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  // Sincroniza catálogo y carrito con un menú nuevo (del fetch inicial, de un
  // menu-updated en vivo o del re-fetch tras reconectar): los items borrados o
  // agotados se sacan del carrito y los precios editados se actualizan, para no
  // dejar que el cliente envíe items que el backend va a rechazar en silencio.
  const applyMenu = (newMenu) => {
    setMenu(newMenu);
    setCart(prevCart => prevCart
      .map(cartItem => {
        const current = newMenu.find(m => m.id === cartItem.id);
        if (!current || !current.available) return null;
        return { ...cartItem, name: current.name, price: current.price };
      })
      .filter(Boolean)
    );
  };

  // Fetch del menú, también tras cada reconexión del socket: el re-join ya re-hidrata
  // mesa y pedidos (el server los re-emite), pero un menu-updated emitido mientras
  // estuvimos sin conexión se perdió y solo se recupera pidiendo el menú de nuevo.
  useEffect(() => {
    const fetchMenu = () => {
      fetch(`${BACKEND_URL}/api/menu`)
        .then(res => res.json())
        .then(applyMenu)
        .catch(err => console.error("Error fetching menu:", err))
        .finally(() => setLoading(false));
    };

    fetchMenu();
    if (!socket) return;
    socket.on('connect', fetchMenu);
    return () => socket.off('connect', fetchMenu);
  }, [socket]);

  // El token del QR viaja en el join: el server ata esta conexión a la mesa solo si es válido.
  // Con la visita terminada no se vuelve a unir, ni siquiera al reconectar el socket: si
  // no, un celular olvidado vería los pedidos del grupo siguiente tras un corte de red.
  useSocketRoom(socket, tableId && !visitEnded ? `table-${tableId}` : null, qrToken, visitCode);

  // Socket Connection and Event Listeners
  useEffect(() => {
    if (!socket) return;

    socket.on('table-state', (state) => {
      if (state) {
        setTableState(state);
        setTableUnavailable(false); // la mesa existe (o volvió a darse de alta)
        // El server aceptó el código: se guarda para la próxima carga.
        setNeedsCode(false);
        setCodeError('');
        storeCode(tableId, qrToken, visitCodeRef.current);
      } else {
        // El backend responde null si la mesa no existe o el token del QR no vale
        setTableUnavailable(true);
      }
    });

    const clearVisit = () => {
      setCart([]);
      setOrders({});
      setNotes('');
    };

    // El mostrador dio de baja la mesa o regeneró su QR mientras la estábamos mirando
    socket.on('table-removed', () => {
      clearVisit();
      setTableUnavailable(true);
    });

    // El QR vale pero falta el código de la visita, o el mostrador lo cambió (changed): se
    // pide de nuevo. El código guardado ya no sirve.
    const askForCode = () => {
      clearVisit();
      setIsCartOpen(false);
      setVisitCode('');
      storeCode(tableId, qrToken, '');
      setNeedsCode(true);
    };
    socket.on('visit-code-required', ({ changed } = {}) => {
      if (changed) setCodeError('El código de la mesa cambió. Pedile el nuevo al personal.');
      askForCode();
    });
    socket.on('visit-code-error', ({ retryAfterMs } = {}) => {
      setCodeError(retryAfterMs
        ? `Demasiados intentos. Probá de nuevo en ${Math.ceil(retryAfterMs / 60000)} min o pedile ayuda al personal.`
        : 'Ese código no es el de la mesa. Revisalo y probá de nuevo.');
      askForCode();
    });

    socket.on('order-status-changed', (order) => {
      if (order && order.tableId === tableId) {
        setOrders(prev => ({ ...prev, [order.id]: order }));
      }
    });

    socket.on('table-closed', () => {
      clearVisit();
      setIsCartOpen(false);
      setAssistanceRequested(false);
      setVisitEnded(true);
    });

    socket.on('assistance-resolved', () => {
      clearTimeout(assistanceTimerRef.current);
      setAssistanceRequested(false);
    });

    // Respuesta del server a request-assistance: si el llamado quedó registrado (o ya
    // había uno en curso), el botón sigue bloqueado hasta assistance-resolved, con el
    // respaldo de 60s por si ese evento se pierde; si lo rechazó por el cooldown
    // post-resolución, se rehabilita justo cuando el cooldown vence (retryInMs).
    socket.on('assistance-ack', ({ accepted, retryInMs } = {}) => {
      armAssistanceTimer(accepted ? 60000 : retryInMs || 10000);
    });

    // El mostrador cambió el menú (alta/edición/baja/stock): catálogo y carrito
    // se sincronizan en vivo con la misma lógica del fetch inicial.
    socket.on('menu-updated', applyMenu);

    return () => {
      socket.off('table-state');
      socket.off('visit-code-required');
      socket.off('visit-code-error');
      socket.off('table-removed');
      socket.off('order-status-changed');
      socket.off('table-closed');
      socket.off('assistance-resolved');
      socket.off('assistance-ack');
      socket.off('menu-updated');
    };
  }, [socket, tableId, qrToken]);

  const submitCode = (e) => {
    e.preventDefault();
    const code = codeInput.trim();
    if (!/^\d{4}$/.test(code)) {
      setCodeError('El código tiene 4 números.');
      return;
    }
    setCodeError('');
    setCodeInput('');
    setVisitCode(code);
  };

  // Llamar al mozo. El botón se rehabilita cuando el mostrador confirma (assistance-resolved),
  // cuando el server rechaza por cooldown (assistance-ack) o, como último respaldo, a los
  // 60s si ninguna respuesta llega (ej. desconexión justo después de emitir).
  const callWaiter = () => {
    // Sin conexión no se emite: el llamado quedaría en el buffer y se perdería al reconectar
    // (ver submitOrder), con el botón bloqueado en "Mozo en camino..." sin ningún llamado real.
    if (assistanceRequested || !socket?.connected) return;
    socket.emit('request-assistance');
    setAssistanceRequested(true);
    armAssistanceTimer(60000);
  };

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

  // El pedido "actual" es el que apunta la mesa en el backend (tableState.currentOrderId),
  // derivado de la colección completa en vez de guardarse aparte.
  const activeOrder = orders[tableState.currentOrderId] || null;

  // Todos los pedidos que todavía cuentan para el total de la mesa (ni cancelados ni
  // ya cobrados), para el desglose de "Mi Cuenta Parcial".
  const partialBillOrders = Object.values(orders)
    .filter(o => !o.archived)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Con la cuenta pedida se puede seguir pidiendo: el server cancela la solicitud de
  // cuenta y el consumo sigue sumando (hay que volver a pedirla al terminar).
  const billRequested = tableState.status === 'esperando_cuenta' || tableState.status === 'pagando_tarjeta';

  // Send Order: cada envío es una comanda nueva para cocina, nunca se modifica un
  // pedido ya enviado (la cuenta de la mesa suma todos los pedidos igual). La mesa no
  // viaja en el payload (el server usa la de la conexión) y nombre y precio tampoco:
  // el server los toma de su menú.
  //
  // El carrito se vacía recién cuando el server confirma. Sin conexión no se emite nada:
  // socket.io guardaría el evento y lo mandaría al reconectar *antes* del join a la mesa,
  // y el server lo descartaría por venir de una conexión sin mesa (pedido perdido sin aviso).
  const submitOrder = () => {
    if (cart.length === 0 || sendingOrder) return;
    if (!socket?.connected) {
      setOrderError('Sin conexión con la cafetería. Esperá a que vuelva la señal y enviá de nuevo.');
      return;
    }

    setSendingOrder(true);
    setOrderError('');
    socket.timeout(8000).emit('new-order', {
      items: cart.map(item => ({ productId: item.id, quantity: item.quantity })),
      notes
    }, (err, res) => {
      setSendingOrder(false);
      if (err) {
        // Puede haber llegado igual: si aparece en "Mi Cuenta Parcial", no hay que reenviarlo.
        setOrderError('No hubo respuesta de la cafetería. Revisá "Mi Cuenta Parcial" antes de volver a enviar.');
        return;
      }
      if (!res?.ok) {
        setOrderError(ORDER_ERRORS[res?.error] || 'No se pudo enviar el pedido. Probá de nuevo.');
        return;
      }
      setCart([]);
      setNotes('');
      setIsCartOpen(false);
    });
  };

  const requestBill = (paymentMethod) => {
    if (socket?.connected) socket.emit('request-bill', { paymentMethod });
  };

  // Solo las categorías con algún producto: una pestaña vacía no le sirve al cliente. Si
  // la categoría elegida desaparece (el mostrador la vació o la borró), se vuelve a "Todo".
  const visibleCategories = categories.filter(c => menu.some(item => item.category === c.id));
  const currentCategory = visibleCategories.some(c => c.id === activeCategory) ? activeCategory : 'todos';
  const filteredMenu = currentCategory === 'todos' ? menu : menu.filter(item => item.category === currentCategory);
  const categoryOf = (item) => categories.find(c => c.id === item.category);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', flexDirection: 'column', gap: '15px' }}>
        <Coffee size={48} className="status-pedido_pendiente" style={{ animation: 'pulse-glow 1.5s infinite' }} />
        <p style={{ color: 'var(--text-secondary)' }}>Cargando menú delicioso...</p>
      </div>
    );
  }

  if (tableUnavailable) {
    return (
      <Notice icon={Coffee} iconColor="var(--text-muted)" title="Esta mesa no está disponible">
        El QR de la mesa {tableId} no es válido o la mesa fue dada de baja. Por favor escaneá de nuevo el QR de tu mesa o consultá al personal de la cafetería.
      </Notice>
    );
  }

  if (visitEnded) {
    return (
      <Notice icon={CheckCircle} iconColor="var(--success)" title="¡Gracias por tu visita!">
        La cuenta de la mesa {tableId} ya está cerrada. Si querés volver a pedir, escaneá de nuevo el QR de la mesa.
      </Notice>
    );
  }

  if (needsCode) {
    return (
      <div className="animate-fade-in" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '70vh' }}>
        <form onSubmit={submitCode} className="glass-panel" style={{ padding: '40px', textAlign: 'center', maxWidth: '420px', width: '100%' }}>
          <KeyRound size={48} style={{ color: 'var(--accent-gold)', margin: '0 auto 16px auto' }} />
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '8px' }}>Mesa {tableId}</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '20px' }}>
            Ingresá el código de 4 números de tu mesa. Te lo da el personal al sentarte.
          </p>
          <input
            aria-label="Código de la mesa"
            className="visit-code-input"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••"
            autoFocus
          />
          {codeError && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.9rem', marginTop: '12px' }}>{codeError}</p>}
          <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '20px', justifyContent: 'center' }} disabled={codeInput.length !== 4}>
            Entrar a la mesa
          </button>
        </form>
      </div>
    );
  }

  // Mesa bloqueada por el Mostrador (antes de iniciar el día, después de cerrarlo o una
  // mesa puntual). Una mesa bloqueada siempre está vacía, así que no hay cuenta que mostrar.
  if (tableState.enabled === false) {
    return (
      <Notice icon={Coffee} iconColor="var(--text-muted)" title="Mesa no habilitada">
        La mesa {tableId} todavía no está habilitada para pedir. Por favor consultá al personal de la cafetería.
      </Notice>
    );
  }

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

        <div style={{ marginTop: '16px' }}>
          <button
            className="btn-secondary"
            style={{ padding: '8px 16px', fontSize: '0.85rem', margin: '0 auto' }}
            onClick={callWaiter}
            disabled={assistanceRequested}
          >
            <Hand size={14} /> {assistanceRequested ? 'Mozo en camino...' : 'Llamar al Mozo'}
          </button>
        </div>
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
                  activeOrder.status === 'listo' ? 'var(--success)' :
                  activeOrder.status === 'cancelado' ? 'var(--danger)' : 'var(--text-secondary)'
                , marginLeft: '5px' }}>
                  {activeOrder.status === 'pendiente' && 'Esperando aprobación'}
                  {activeOrder.status === 'en_preparacion' && 'En preparación 🍳'}
                  {activeOrder.status === 'listo' && '¡Listo para retirar! ☕'}
                  {activeOrder.status === 'entregado' && 'Entregado'}
                  {activeOrder.status === 'cancelado' && 'Cancelado por el mostrador'}
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Orden ID: {activeOrder.id.slice(-6)}
              </p>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <div className={`badge ${
                activeOrder.status === 'pendiente' ? 'badge-pending' :
                activeOrder.status === 'en_preparacion' ? 'badge-cooking' :
                activeOrder.status === 'listo' ? 'badge-ready' :
                activeOrder.status === 'cancelado' ? 'badge-cancelled' : 'badge-delivered'
              }`}>
                {activeOrder.status === 'pendiente' && <Clock size={12} />}
                {activeOrder.status === 'en_preparacion' && <ChefHat size={12} />}
                {activeOrder.status === 'listo' && <CheckCircle size={12} />}
                {activeOrder.status === 'entregado' && <CheckCircle size={12} />}
                {activeOrder.status === 'cancelado' && <X size={12} />}
                {activeOrder.status}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mi Cuenta Parcial: desglose colapsable de todo lo pedido en la sesión actual */}
      {partialBillOrders.length > 0 && (
        <div className="glass-panel" style={{ padding: '16px 20px', marginBottom: '24px' }}>
          <button
            onClick={() => setShowPartialBill(v => !v)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
              background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer',
              padding: 0, fontFamily: 'var(--font-main)'
            }}
          >
            <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Receipt size={16} style={{ color: 'var(--accent-gold)' }} /> Mi Cuenta Parcial
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
              {formatPrice(tableState.total)} {showPartialBill ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </span>
          </button>

          {showPartialBill && (
            <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
              {partialBillOrders.map((order, orderIdx) => (
                <div key={order.id} style={{ marginBottom: '12px' }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Pedido {orderIdx + 1}</p>
                  {order.items.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', padding: '4px 0' }}>
                      <span>{item.quantity}x {item.name}</span>
                      <span>{formatPrice(item.price * item.quantity)}</span>
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                <span>Total:</span>
                <span style={{ color: 'var(--accent-gold)' }}>{formatPrice(tableState.total)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table Action Controls (Closing Check) */}
      {tableState.status === 'comiendo' && (
        <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px', textAlign: 'center' }}>
          <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '8px' }}>¿Deseas cerrar tu cuenta?</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '16px', fontSize: '0.9rem' }}>
            Consumo total actual: <span style={{ fontWeight: 700, color: 'var(--accent-gold)', fontSize: '1.1rem' }}>{formatPrice(tableState.total)}</span>
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
      {billRequested && (
        <div className="glass-panel" style={{ padding: '30px', textAlign: 'center', marginBottom: '24px', border: '1px solid var(--accent-gold)' }}>
          <Bell size={48} className="status-pedido_pendiente" style={{ margin: '0 auto 16px auto', animation: 'pulse-glow 1.5s infinite' }} />
          <h3 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Cuenta Solicitada</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '8px', maxWidth: '350px', margin: '8px auto 0 auto' }}>
            {tableState.status === 'esperando_cuenta'
              ? 'El encargado se acercará a la mesa a traerte la cuenta y cobrar en efectivo.'
              : 'Acércate al mostrador para realizar el pago con tu tarjeta de débito o crédito.'}
          </p>
          <div style={{ marginTop: '20px', fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>
            Total: {formatPrice(tableState.total)}
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: '12px', fontSize: '0.9rem' }}>
            ¿Te olvidaste de algo? Podés seguir pidiendo, pero se cancela la solicitud de cuenta.
          </p>
        </div>
      )}

      {/* Menú: se muestra en todos los estados de la mesa (con la cuenta pedida también
          se puede seguir pidiendo, y el pedido nuevo la cancela) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Nuestro Menú</h3>
      </div>

      {/* Categories Filter Bar */}
      <div className="filter-bar">
        {[{ id: 'todos', name: 'Todo' }, ...visibleCategories].map(cat => (
          <button
            key={cat.id}
            className={`filter-btn ${currentCategory === cat.id ? 'active' : ''}`}
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {/* Menu Grid */}
      <div className="menu-grid">
        {filteredMenu.map(item => (
          <div key={item.id} className="glass-panel menu-card" style={item.available === false ? { opacity: 0.55 } : undefined}>
            <div className="menu-card-img-container">
              {item.imageId ? (
                <img className="menu-card-img" src={imageUrl(item.imageId)} alt={item.name} loading="lazy" />
              ) : (
                <div className="menu-card-img-placeholder">
                  {categoryOf(item)?.icon || '☕'}
                </div>
              )}
            </div>
            <div className="menu-card-content">
              <span className="menu-card-category">
                {categoryOf(item)?.name}
              </span>
              <h4 className="menu-card-title">{item.name}</h4>
              <p className="menu-card-description">{item.description}</p>

              <div className="menu-card-footer">
                <span className="menu-card-price">{formatPrice(item.price)}</span>
                {item.available === false ? (
                  <button
                    className="btn-secondary"
                    style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '0.85rem', cursor: 'not-allowed' }}
                    disabled
                  >
                    Agotado
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    style={{ padding: '8px 16px', borderRadius: '8px', fontSize: '0.85rem' }}
                    onClick={() => addToCart(item)}
                  >
                    <Plus size={14} /> Agregar
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Floating Cart Button (portaled to <body> so it stays fixed to the viewport,
          not to the animated .animate-fade-in wrapper, which creates its own containing block) */}
      {cart.length > 0 && createPortal(
        <button className="cart-float-btn" onClick={() => { setOrderError(''); setIsCartOpen(true); }}>
          <ShoppingBag size={24} />
          <span className="cart-badge">{cart.reduce((sum, item) => sum + item.quantity, 0)}</span>
        </button>,
        document.body
      )}

      {/* Shopping Cart Modal overlay (portaled for the same reason) */}
      {isCartOpen && createPortal(
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
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{formatPrice(item.price)} c/u</span>
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
                maxLength={MAX_NOTES_LENGTH}
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
              <span style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>{formatPrice(cartTotal)}</span>
            </div>

            {billRequested && (
              <p style={{ color: 'var(--accent-gold)', marginTop: '16px', fontSize: '0.9rem', textAlign: 'center' }}>
                Ya pediste la cuenta: al enviar este pedido se cancela y el consumo sigue sumando.
              </p>
            )}

            {orderError && (
              <p role="alert" style={{ color: 'var(--danger)', marginTop: '16px', fontSize: '0.9rem', textAlign: 'center' }}>
                {orderError}
              </p>
            )}

            <button
              className="btn-primary"
              style={{ width: '100%', marginTop: '20px' }}
              onClick={submitOrder}
              disabled={sendingOrder}
            >
              {sendingOrder ? 'Enviando...' : 'Confirmar y Enviar Pedido'}
            </button>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
}
