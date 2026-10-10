const eventName = 'uco:identity-retired';

export function announceIdentityRetirement(target: Window = window): void {
  target.localStorage.setItem(eventName, crypto.randomUUID());
  target.dispatchEvent(new Event(eventName));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(eventName);
    channel.postMessage(eventName);
    channel.close();
  }
}

export function observeRetirement(lock: () => void, target: Window = window): () => void {
  let observed = target.localStorage.getItem(eventName);
  const retire = () => { observed = target.localStorage.getItem(eventName); lock(); };
  const storage = (event: StorageEvent) => { if (event.key === eventName) retire(); };
  const notify = () => target.dispatchEvent(new Event(eventName));
  const resume = () => { if (observed !== target.localStorage.getItem(eventName)) notify(); };
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(eventName);
  if (channel) channel.onmessage = notify;
  target.addEventListener('storage', storage);
  target.addEventListener(eventName, retire);
  target.addEventListener('focus', resume);
  target.document.addEventListener('visibilitychange', resume);
  return () => {
    channel?.close();
    target.removeEventListener('storage', storage);
    target.removeEventListener(eventName, retire);
    target.removeEventListener('focus', resume);
    target.document.removeEventListener('visibilitychange', resume);
  };
}
