"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const InspectorContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  active: boolean;
  register: () => () => void;
} | null>(null);

/** Pages keep their editor state while the shell moves or docks the inspector. */
export function InspectorProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  const register = useMemo(
    () => () => {
      setCount((value) => value + 1);
      return () => setCount((value) => value - 1);
    },
    [],
  );
  const value = useMemo(
    () => ({ target, setTarget, active: count > 0, register }),
    [target, count, register],
  );
  return (
    <InspectorContext.Provider value={value}>
      {children}
    </InspectorContext.Provider>
  );
}

export function useHasInspector(): boolean {
  return useContext(InspectorContext)?.active ?? false;
}

export function InspectorSlot() {
  const context = useContext(InspectorContext);
  return <div ref={context?.setTarget} />;
}

export function InspectorContent({ children }: { children: ReactNode }) {
  const context = useContext(InspectorContext);
  const register = context?.register;
  useEffect(() => register?.(), [register]);
  return context?.target ? createPortal(children, context.target) : null;
}
