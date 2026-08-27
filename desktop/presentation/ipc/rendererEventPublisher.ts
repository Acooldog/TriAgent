export interface RendererEventTarget {
  webContents: {
    send(channel: string, ...args: unknown[]): void;
  };
}

export function createRendererEventPublisher(getTarget: () => RendererEventTarget | null): (channel: string, ...args: unknown[]) => boolean {
  return (channel: string, ...args: unknown[]): boolean => {
    const target = getTarget();
    if (!target) return false;
    target.webContents.send(channel, ...args);
    return true;
  };
}
