import os from 'node:os';
import path from 'node:path';

// Alles der Kette liegt unter ~/.kette, überschreibbar für Tests und Firmen-Installationen
export const home = () => process.env.KETTE_HOME || path.join(os.homedir(), '.kette');
export const bundlesDir = () => path.join(home(), 'bundles');
export const credentialsFile = () => path.join(home(), 'credentials');
export const stateFile = () => path.join(home(), 'state.json');
export const mirror = () => (process.env.KETTE_MIRROR || 'https://kette.itdone.de/dl').replace(/\/$/, '');
