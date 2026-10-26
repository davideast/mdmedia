"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const InspectorContext = createContext<{ target: HTMLDivElement | null; setTarget: (target: HTMLDivElement | null) => void } | null>(null);

/** Pages keep their editor state while the shell moves or docks the inspector. */
export function InspectorProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function InspectorSlot() {
  const context = useContext(InspectorContext);
  return <div ref={context?.setTarget} />;
}

export function InspectorContent({ children }: { children: ReactNode }) {
  const context = useContext(InspectorContext);
  return context?.target ? createPortal(children, context.target) : null;
}
