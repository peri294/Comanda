import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { Coffee, Monitor, ChefHat, Volume2, Info, ExternalLink } from 'lucide-react';
import ClientView from './components/ClientView';
import KitchenView from './components/KitchenView';
import CounterView from './components/CounterView';
import { createAudioContext, playTone } from './utils/sound';

export default function App() {
  const [view, setView] = useState('portal'); // 'portal', 'client', 'kitchen', 'counter'
  const [tableId, setTableId] = useState(null);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  // Check URL parameters for routing
  useEffect(() => {
    const handleUrlRouting = () => {
      const params = new URLSearchParams(window.location.search);
      const viewParam = params.get('view');
      const tableParam = params.get('table');

      if (viewParam === 'client' && tableParam) {
        setView('client');
        setTableId(tableParam);
      } else if (viewParam === 'kitchen') {
        setView('kitchen');
      } else if (viewParam === 'counter') {
        setView('counter');
      } else {
        setView('portal');
      }
    };

    handleUrlRouting();
    window.addEventListener('popstate', handleUrlRouting);
    return () => window.removeEventListener('popstate', handleUrlRouting);
  }, []);

  // Initialize Socket.io Connection
  useEffect(() => {
    const newSocket = io('http://localhost:3001', {
      transports: ['websocket', 'polling']
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('Conectado al servidor de Sockets');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Desconectado del servidor de Sockets');
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  // Audio test helper
  const testChime = () => {
    try {
      const ctx = createAudioContext();
      const gainNode = playTone(ctx, { freq: 523.25, gain: 0.1, duration: 0.4 }); // C5
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    } catch (e) {
      alert("Por favor habilita el audio interactuando con la página primero.");
    }
  };

  // Helper to change view and update browser URL without reloading
  const navigateTo = (newView, table = null) => {
    const params = new URLSearchParams();
    if (newView !== 'portal') {
      params.set('view', newView);
      if (table) params.set('table', table);
    }
    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.pushState({}, '', newUrl);
    
    setView(newView);
    // Normalizado a string: el backend compara el id de mesa como string,
    // y el botón "Ir a Mesa" pasa un número mientras que la URL siempre da un string.
    setTableId(table !== null ? String(table) : null);
  };

  return (
    <div className="app-container">
      {/* Universal Header */}
      <header className="header">
        <div className="logo" onClick={() => navigateTo('portal')} style={{ cursor: 'pointer' }}>
          <Coffee style={{ color: 'var(--accent-gold)' }} />
          <span>CAFÉ</span> PREMIUM
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Connection Status Badge */}
          <span 
            className="badge" 
            style={{ 
              background: isConnected ? 'rgba(96, 180, 123, 0.12)' : 'rgba(231, 111, 81, 0.12)',
              color: isConnected ? 'var(--success)' : 'var(--danger)',
              border: `1px solid ${isConnected ? 'rgba(96, 180, 123, 0.3)' : 'rgba(231, 111, 81, 0.3)'}`,
              fontSize: '0.8rem'
            }}
          >
            <span style={{ 
              width: '6px', 
              height: '6px', 
              borderRadius: '50%', 
              background: isConnected ? 'var(--success)' : 'var(--danger)',
              display: 'inline-block',
              marginRight: '6px'
            }} />
            {isConnected ? 'Servidor Conectado' : 'Sin Conexión'}
          </span>

          {view !== 'portal' && (
            <button 
              className="btn-secondary" 
              style={{ padding: '6px 12px', fontSize: '0.8rem', borderRadius: '8px' }}
              onClick={() => navigateTo('portal')}
            >
              Volver al Portal
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-content">
        
        {/* VIEW 1: Customer View */}
        {/* key={tableId} fuerza un remount completo al cambiar de mesa en la misma pestaña,
            evitando que el carrito/pedido activo de una mesa quede pegado al pasar a otra */}
        {view === 'client' && tableId && (
          <ClientView key={tableId} tableId={tableId} socket={socket} />
        )}

        {/* VIEW 2: Kitchen Screen */}
        {view === 'kitchen' && (
          <KitchenView socket={socket} />
        )}

        {/* VIEW 3: Counter/Manager Dashboard */}
        {view === 'counter' && (
          <CounterView socket={socket} />
        )}

        {/* VIEW 4: Simulator Portal */}
        {view === 'portal' && (
          <div className="animate-fade-in" style={{ maxWidth: '1000px', margin: '0 auto' }}>
            
            {/* Hero Section */}
            <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', marginBottom: '30px' }}>
              <div className="coffee-cup-illustration">
                <Coffee size={50} style={{ color: 'var(--accent-gold)' }} />
              </div>
              <h1 style={{ fontSize: '2.2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
                Sistema de Pedidos QR para Cafetería
              </h1>
              <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '0 auto 24px auto', fontSize: '1rem', lineHeight: '1.6' }}>
                Bienvenido al simulador interactivo. Desde aquí puedes abrir las diferentes pantallas para ver cómo interactúan en tiempo real mediante WebSockets.
              </p>
              
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', flexWrap: 'wrap' }}>
                <button className="btn-primary" onClick={testChime}>
                  <Volume2 size={18} /> Probar Audio
                </button>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  <Info size={16} /> (Habilita el audio interactuando con la página)
                </div>
              </div>
            </div>

            {/* Admin and Kitchen Panels Row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '30px', flexWrap: 'wrap' }}>
              
              {/* Counter Box */}
              <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', height: '100%' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                  <Monitor style={{ color: 'var(--accent-gold)' }} /> Pantalla del Mostrador
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px', flex: 1 }}>
                  Vista para el cajero/encargado. Monitorea las 12 mesas, muestra los pedidos y totales en consumo, recibe alertas de solicitudes de cierre de cuenta y procesa cobros.
                </p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button className="btn-primary" style={{ flex: 1 }} onClick={() => navigateTo('counter')}>
                    Abrir Mostrador
                  </button>
                  <a href="?view=counter" target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: '12px' }}>
                    <ExternalLink size={16} />
                  </a>
                </div>
              </div>

              {/* Kitchen Box */}
              <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', height: '100%' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                  <ChefHat style={{ color: 'var(--accent-gold)' }} /> Monitor de Cocina
                </h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px', flex: 1 }}>
                  Vista para los chefs y cocineros. Lista los pedidos entrantes clasificados cronológicamente, muestra los detalles de los productos y sus notas, y permite avanzar su preparación.
                </p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button className="btn-primary" style={{ flex: 1 }} onClick={() => navigateTo('kitchen')}>
                    Abrir Cocina
                  </button>
                  <a href="?view=kitchen" target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: '12px' }}>
                    <ExternalLink size={16} />
                  </a>
                </div>
              </div>

            </div>

            {/* QR Simulator Tables Grid */}
            <div className="glass-panel qr-simulator-box">
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                <Coffee style={{ color: 'var(--accent-gold)' }} /> Simulador de Códigos QR en Mesas
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px', maxWidth: '600px', margin: '6px auto 0 auto' }}>
                Haz clic en cualquier mesa para simular el escaneo del código QR por parte de un cliente. Se recomienda abrir las mesas en pestañas nuevas para probar el flujo simultáneo.
              </p>

              <div className="qr-grid">
                {Array.from({ length: 12 }, (_, i) => {
                  const tableNum = i + 1;
                  return (
                    <div key={tableNum} className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255, 255, 255, 0.02)' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-gold)' }}>Mesa {tableNum}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <button 
                          className="btn-primary" 
                          style={{ padding: '6px 8px', fontSize: '0.75rem', borderRadius: '6px', width: '100%' }}
                          onClick={() => navigateTo('client', tableNum)}
                        >
                          Ir a Mesa
                        </button>
                        <a 
                          href={`?view=client&table=${tableNum}`} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="btn-secondary" 
                          style={{ padding: '6px 8px', fontSize: '0.75rem', borderRadius: '6px', width: '100%', textDecoration: 'none', color: 'var(--accent-gold)' }}
                        >
                          Nueva Pestaña
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        )}

      </main>
    </div>
  );
}
