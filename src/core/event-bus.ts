import type { BridgeEvent } from './types.ts';

type Listener = (event: BridgeEvent) => void;

export class EventBus {
  #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(origin: string, source: string, type: string, data: unknown): BridgeEvent {
    const event: BridgeEvent = { source, type, data: data ?? {}, timeStamp: new Date().toISOString(), origin };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
    return event;
  }
}
