# QR Coffee Shop (PPR)

Un sistema de gestión de cafetería en tiempo real con arquitectura cliente-servidor, diseñado para coordinar pedidos entre clientes, cocina y mostrador de forma fluida.

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socket.io&logoColor=white)

## 🎯 Descripción
QR Coffee Shop es un sistema integral que digitaliza el proceso de toma de pedidos. Permite a los clientes realizar pedidos desde sus mesas mediante códigos QR, mientras la cocina y el mostrador reciben actualizaciones instantáneas, eliminando cuellos de botella en la comunicación.

## 🚀 Características Principales
* **Comunicación en Tiempo Real:** Actualizaciones inmediatas entre vistas mediante WebSockets (`Socket.io`).
* **Arquitectura Unificada:** Un único build de frontend que sirve para tres roles (Cliente, Cocina, Mostrador) mediante parámetros de consulta.
* **UI/UX Moderna:** Diseño inspirado en *Glassmorphism* con modo oscuro nativo.
* **Sistema de Notificaciones:** Sistema de audio sintético para alertas instantáneas en cocina y mostrador.

## 🏗️ Arquitectura
El sistema utiliza una arquitectura cliente-servidor eficiente:

```
                      +-------------------+
                      |   Servidor Node   |
                      | (Express/Sockets) |
                      +---------+---------+
                                |
        +-----------------------+-----------------------+
        |                       |                       |
+-------v-------+       +-------v-------+       +-------v-------+
|  Cliente (QR) |       | Cocina Screen |       | Mostrador UI  |
| (Mobile View) |       | (Order Board) |       |  (Dashboard)  |
+---------------+       +---------------+       +---------------+
```

## 🛠️ Stack Tecnológico
- **Frontend:** React (Vite), CSS Custom.
- **Backend:** Node.js, Express, Socket.io.
- **Comunicación:** WebSockets para baja latencia.

## 💻 Guía de Ejecución

1. **Requisitos:** Tener instalado [Node.js](https://nodejs.org/).
2. **Backend:**
   ```bash
   cd backend
   npm install
   npm run dev
   ```
3. **Frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
4. **Acceso:** Abrir `http://localhost:5173/` y usar los parámetros de vista (ej. `?view=client`, `?view=kitchen`, `?view=counter`).

## 📝 Licencia
Este proyecto es parte del portfolio de desarrollo de [peri294](https://github.com/peri294).
