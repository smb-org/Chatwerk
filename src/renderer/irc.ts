import type { ChatStatus } from "../shared/protocol";
import { parseIrcLine, type IrcEvent } from "./irc-parse";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const CONNECT_TIMEOUT_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 6 * 60_000;
const MAX_RECONNECT_MS = 30_000;

export interface IrcTransport {
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  send(line: string): void;
  close(): void;
}

export interface IrcClientOptions {
  channel: string;
  transportFactory?: (url: string) => IrcTransport;
  onEvent?: (event: IrcEvent) => void;
  onStatus?: (status: ChatStatus) => void;
  random?: () => number;
  randomValues?: () => number;
}

export function isValidChannel(channel: string): boolean {
  return /^[a-z0-9_]{1,25}$/u.test(channel.toLowerCase().replace(/^#/u, ""));
}

export class IrcClient {
  private readonly channel: string;
  private readonly transportFactory: (url: string) => IrcTransport;
  private readonly onEvent: (event: IrcEvent) => void;
  private readonly onStatus: (status: ChatStatus) => void;
  private status: ChatStatus = "idle";
  private readonly random: () => number;
  private readonly randomValues: () => number;
  private transport: IrcTransport | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private lastNicknameNumber: number | undefined;
  private started = false;

  constructor(options: IrcClientOptions) {
    this.channel = options.channel.toLowerCase().replace(/^#/u, "");
    this.transportFactory = options.transportFactory ?? createBrowserTransport;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    this.random = options.random ?? Math.random;
    this.randomValues = options.randomValues ?? browserRandomValue;
  }

  start(): void {
    if (this.started || !isValidChannel(this.channel)) return;
    this.started = true;
    this.reconnectAttempt = 0;
    this.setStatus("reconnecting");
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearConnectionTimers();
    const transport = this.transport;
    this.transport = undefined;
    transport?.close();
    this.setStatus("idle");
  }

  private connect(): void {
    if (!this.started || this.transport) return;
    let transport: IrcTransport;
    try {
      transport = this.transportFactory(IRC_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.transport = transport;
    this.connectTimer = setTimeout(() => this.disconnect(transport), CONNECT_TIMEOUT_MS);
    let receivedRoomState = false;
    transport.onOpen(() => {
      if (!this.started || this.transport !== transport) return;
      this.clearConnectTimer();
      transport.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      transport.send("PASS SCHMOOPIIE");
      transport.send(`NICK justinfan${this.nicknameNumber()}`);
      transport.send(`JOIN #${this.channel}`);
      this.resetLivenessTimer(transport);
    });
    transport.onMessage((data) => {
      if (!this.started || this.transport !== transport) return;
      this.resetLivenessTimer(transport);
      for (const line of data.split(/\r\n|\n|\r/u)) {
        const event = parseIrcLine(line);
        if (!event) continue;
        if (event.type === "PING") {
          transport.send(`PONG :${event.payload}`);
        } else if (event.type === "RECONNECT") {
          this.reconnectImmediately(transport);
          return;
        } else if (isLoginCollision(event)) {
          this.setStatus("reconnecting");
          this.transport = undefined;
          this.clearConnectionTimers();
          transport.close();
          this.scheduleReconnect();
          return;
        } else {
          if (event.type === "ROOMSTATE" && !receivedRoomState) {
            this.reconnectAttempt = 0;
            receivedRoomState = true;
            this.setStatus("connected");
          }
          this.onEvent(event);
        }
      }
    });
    transport.onClose(() => this.disconnect(transport));
  }

  private nicknameNumber(): number {
    let number = (Math.abs(Math.trunc(this.randomValues())) % 999_999_999) + 1;
    if (number === this.lastNicknameNumber) number = number === 999_999_999 ? 1 : number + 1;
    this.lastNicknameNumber = number;
    return number;
  }

  private reconnectImmediately(transport: IrcTransport): void {
    if (this.transport !== transport) return;
    this.setStatus("reconnecting");
    this.transport = undefined;
    this.clearConnectionTimers();
    transport.close();
    this.connect();
  }

  private disconnect(transport: IrcTransport): void {
    if (this.transport !== transport) return;
    this.setStatus("reconnecting");
    this.transport = undefined;
    this.clearConnectionTimers();
    transport.close();
    this.scheduleReconnect();
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return;
    const exponent = Math.min(this.reconnectAttempt, 30);
    const base = Math.min(1_000 * 2 ** exponent, MAX_RECONNECT_MS);
    const random = Math.max(0, Math.min(1, this.random()));
    const delay = Math.min(MAX_RECONNECT_MS, Math.round(base * (0.5 + random)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private resetLivenessTimer(transport: IrcTransport): void {
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => this.disconnect(transport), LIVENESS_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private clearConnectionTimers(): void {
    this.clearConnectTimer();
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.livenessTimer = undefined;
  }
}

function isLoginCollision(event: IrcEvent): boolean {
  return event.type === "NOTICE" &&
    (event.messageId === "login_authentication_failed" || /login unsuccessful/iu.test(event.text));
}

function browserRandomValue(): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0]!;
}

function createBrowserTransport(url: string): IrcTransport {
  return createIrcTransport(new WebSocket(url));
}

export function createIrcTransport(socket: WebSocket): IrcTransport {
  return {
    onOpen(handler) { socket.addEventListener("open", handler, { once: true }); },
    onMessage(handler) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") handler(event.data);
      });
    },
    onClose(handler) {
      socket.addEventListener("close", handler, { once: true });
      socket.addEventListener("error", handler, { once: true });
    },
    send(line) {
      if (!/[\r\n]/u.test(line) && socket.readyState === WebSocket.OPEN) socket.send(`${line}\r\n`);
    },
    close() {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    },
  };
}
