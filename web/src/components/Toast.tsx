import { useEffect, useState } from "react";

type Toast = { id: number; message: string; tone: "info" | "error" | "success" };
let push: (t: Omit<Toast, "id">) => void = () => {};
let seq = 0;

export const toast = {
  info: (message: string) => push({ message, tone: "info" }),
  success: (message: string) => push({ message, tone: "success" }),
  error: (message: string) => push({ message, tone: "error" }),
};

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    push = (t) => {
      const id = ++seq;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 7000 : 3500);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
