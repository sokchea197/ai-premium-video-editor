import { useEffect, useState } from "react";
import { Library } from "./components/Library";
import { Editor } from "./components/Editor";
import { ToastHost } from "./components/Toast";

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export const navigate = (to: string) => {
  window.location.hash = to;
};

export function App() {
  const hash = useHashRoute();
  const m = /^#\/p\/([a-f0-9-]{36})/.exec(hash);
  return (
    <>
      {m ? <Editor key={m[1]} projectId={m[1]} /> : <Library />}
      <ToastHost />
    </>
  );
}
