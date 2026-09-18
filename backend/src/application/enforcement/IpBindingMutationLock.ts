let tail: Promise<void> = Promise.resolve();

export function withIpBindingMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous.then(operation).finally(release);
}
