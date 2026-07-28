import {EventEmitter} from "node:events";
import type {ServerMessage} from "../types.js";

/**
 * In-process fan-out from the services to the WebSocket server.
 *
 * Services publish here rather than importing the WS server directly, which keeps the
 * dependency one-way (services -> bus <- api) and lets the relayer run headless in a
 * deployment where the API is not started at all.
 */
class MessageBus extends EventEmitter {
  publish(message: ServerMessage): void {
    this.emit("message", message);
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.on("message", listener);
    return () => this.off("message", listener);
  }
}

export const bus = new MessageBus();
// The relayer, indexer, price poller and every WS client all attach; the default cap of 10
// produces spurious leak warnings well before anything is actually wrong.
bus.setMaxListeners(200);
