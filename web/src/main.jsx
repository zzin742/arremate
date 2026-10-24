import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './estilo.css';

createRoot(document.getElementById('raiz')).render(
  <StrictMode><App /></StrictMode>,
);
