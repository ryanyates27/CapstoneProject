// src/App.jsx
import { useEffect, useState } from 'react';

export default function App() {
  const [msg, setMsg] = useState('...');

  useEffect(() => {
    async function run() {
      try {
        const res = await window.api?.ping?.();
        setMsg(res || 'no api');
      } catch (err) {
        setMsg(String(err));
      }
    }
    run();
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0b1220',
        color: 'white',
        display: 'grid',
        placeItems: 'center',
        fontFamily:
          'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, sans-serif',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1>Vite + React + Electron</h1>
        <p>
          IPC check: <code>{msg}</code>
        </p>
      </div>
    </div>
  );
}
