export function ensureFusionBusinessWindowCreation<T>(input: {
  create(): Promise<T>;
  inFlight: Map<string, Promise<T>>;
  windowInstanceId: string;
}): Promise<T> {
  const existing = input.inFlight.get(input.windowInstanceId);
  if (existing) {
    return existing;
  }

  let creation: Promise<T>;
  creation = Promise.resolve()
    .then(input.create)
    .finally(() => {
      if (input.inFlight.get(input.windowInstanceId) === creation) {
        input.inFlight.delete(input.windowInstanceId);
      }
    });
  input.inFlight.set(input.windowInstanceId, creation);
  return creation;
}
