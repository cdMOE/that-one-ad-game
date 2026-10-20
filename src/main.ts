import './style.css';
import { Game } from './game';

const stage = document.getElementById('stage');
if (!stage) throw new Error('Missing #stage element');
new Game(stage);
