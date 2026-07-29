export type ServiceListener = () => void;

export abstract class ObservableService<TSnapshot> {
  private readonly listeners = new Set<ServiceListener>();

  abstract getSnapshot(): TSnapshot;

  subscribe = (listener: ServiceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  protected clearListeners(): void {
    this.listeners.clear();
  }
}
