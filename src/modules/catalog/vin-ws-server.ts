/**
 * vin-ws-server.ts
 * WebSocket bridge giua Catalog API va Chrome Extension
 * 
 * Flow:
 * 1. Extension ket noi ws://localhost:3002
 * 2. API gui lenh: { type:'lookup', vin:'...' }
 * 3. Extension mo Partsouq, extract model_code
 * 4. Extension gui ket qua: { type:'result', vin:'...', vehicles:[...] }
 * 5. API nhan ket qua, tra ve cho caller
 */

import { WebSocketServer, WebSocket } from 'ws';

const WSS_PORT = 3002;

interface PendingRequest {
  vin     : string;
  resolve : (vehicles: any[]) => void;
  reject  : (err: Error) => void;
  timer   : NodeJS.Timeout;
}

class VinWebSocketBridge {
  private wss      : WebSocketServer;
  private extension: WebSocket | null = null;
  private pending  : Map<string, PendingRequest> = new Map();

  constructor() {
    this.wss = new WebSocketServer({ port: WSS_PORT });
    this.wss.on('connection', (ws) => this.onConnect(ws));
    console.log(`[VIN-WS] WebSocket bridge listening on ws://localhost:${WSS_PORT}`);
  }

  private onConnect(ws: WebSocket) {
    console.log('[VIN-WS] Extension connected');
    this.extension = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch(e) {
        console.error('[VIN-WS] Parse error:', e);
      }
    });

    ws.on('close', () => {
      console.log('[VIN-WS] Extension disconnected');
      if (this.extension === ws) this.extension = null;
      // Reject tat ca pending requests
      for (const [vin, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Extension disconnected'));
        this.pending.delete(vin);
      }
    });

    ws.on('error', (e) => console.error('[VIN-WS] WS error:', e));

    // Gui pending requests neu co
    for (const [vin] of this.pending) {
      this.sendLookup(vin);
    }
  }

  private handleMessage(msg: any) {
    console.log('[VIN-WS] Message from extension:', msg.type, msg.vin);

    if (msg.type === 'result') {
      const req = this.pending.get(msg.vin);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(msg.vin);
        req.resolve(msg.vehicles || []);
      }
    } else if (msg.type === 'error') {
      const req = this.pending.get(msg.vin);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(msg.vin);
        req.reject(new Error(msg.error || 'Extension error'));
      }
    } else if (msg.type === 'ping') {
      this.extension?.send(JSON.stringify({ type: 'pong' }));
    }
  }

  private sendLookup(vin: string) {
    if (this.extension?.readyState === WebSocket.OPEN) {
      this.extension.send(JSON.stringify({ type: 'lookup', vin }));
      console.log(`[VIN-WS] Sent lookup request for VIN: ${vin}`);
    }
  }

  // API goi ham nay de request VIN lookup
  async lookup(vin: string, timeoutMs = 30000): Promise<any[]> {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome Extension chua ket noi. Mo Chrome va bat extension VIN Lookup.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(vin);
        reject(new Error('Timeout sau 30s — Partsouq qua cham hoac extension bi loi'));
      }, timeoutMs);

      this.pending.set(vin, { vin, resolve, reject, timer });
      this.sendLookup(vin);
    });
  }

  isConnected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }
}

// Singleton
export const vinBridge = new VinWebSocketBridge();