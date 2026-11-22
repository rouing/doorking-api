import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@radix-ui/themes/styles.css';
import './styles.css';
import { App } from './App.tsx';
import { stackTablesOnPhones } from './stackTables.ts';
import { lsGet } from './api.ts';

stackTablesOnPhones();
// Dark mode before the page draws (no white flash at start): the account's setting, remembered by this browser (App).
document.documentElement.style.colorScheme = lsGet('dk-theme', false) ? 'dark' : 'light';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
