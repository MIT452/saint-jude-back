import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

let io: Server | null = null;

export function initRealtime(http: HttpServer, origin: string) {
  io = new Server(http, { cors: { origin } });
  io.on('connection', (socket) => {
    console.log('Client temps réel connecté', socket.id);
  });
}

export function emitPosition(p: unknown) {
  io?.emit('position', p);
}