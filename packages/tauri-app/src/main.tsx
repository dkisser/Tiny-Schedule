import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootstrap } from './bridge/bootstrap';
import './styles.css';

// The store has to be open and migrated before the first render, or App would
// mount against a half-initialised api() and every call would throw.
await bootstrap();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
